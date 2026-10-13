// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Page de mesure : la carte choisit la photo, la visionneuse Panoramax reçoit les clics,
// le cœur de calcul du plugin (Pyodide, voir calcul.js) fait les mesures.

import {
  createMap, nearestPhoto, photoById, setBackground, showHandles, showMeasures, showPhoto,
} from "./carte.js";
import { startCalcul } from "./calcul.js";
import { checkServices } from "./services.js";

const $ = (selector) => document.querySelector(selector);
const viewer = $("#visionneuse");
const map = createMap("carte");
let app = null;  // web_app.App, une fois Pyodide chargé
let photo = null;  // fiche STAC de la photo affichée
let psv = null;  // visionneuse sphérique (Photo Sphere Viewer) dans <pnx-photo-viewer>

checkServices($("#reseau ul"));
$("#fond").addEventListener("change", (event) => setBackground(map, event.target.value));

// Calcul ---------------------------------------------------------------------------------

function setStatus(text, kind = "") {
  const status = $("#statut");
  status.textContent = text;
  status.className = "statut " + kind;
}

startCalcul(() => refresh()).then((created) => {
  app = created;
  for (const id of ["#mode", "#camera", "#facade", "#effacer", "#tout-effacer"]) $(id).disabled = false;
  app.set_camera_height(Number($("#camera").value));
  if (photo) app.set_picture(JSON.stringify(photo));
  refresh();
}).catch((error) => {
  console.error(error);
  setStatus(`Calcul indisponible : ${error.message}`, "echec");
});

/** Redessine les repères dans la photo, les mesures sur la carte et le texte de la mesure. */
function refresh(text) {
  if (!app) return;
  setStatus(text ?? app.status());
  drawViewerMarks(JSON.parse(app.viewer_marks()));
  showMeasures(map, JSON.parse(app.map_geojson()));
  showHandles(map, JSON.parse(app.handles()), (index, lon, lat) => refresh(app.move_handle(index, lon, lat)));
  const results = app.has_results();
  $("#csv").disabled = !results;
  $("#geojson").disabled = !results;
}

// Choix de la photo sur la carte ---------------------------------------------------------

map.on("click", async (event) => {
  const { lng, lat } = event.lngLat;
  showPhotoInfo(null, "Recherche de la photo la plus proche…");
  try {
    const feature = await nearestPhoto(map, lng, lat);
    if (!feature) {
      showPhotoInfo(null, "Aucune photo près de ce point : cliquez sur le filaire orange.");
      return;
    }
    openPhoto(feature, false);
  } catch (error) {
    showPhotoInfo(null, `Recherche impossible : ${error.message}`);
  }
});

function openPhoto(feature, recenter) {
  setPhoto(feature, recenter);
  $("#invite").hidden = true;
  viewer.hidden = false;
  if (viewer.getAttribute("picture") !== feature.id) viewer.setAttribute("picture", feature.id);
  attachViewer();
}

function setPhoto(feature, recenter) {
  photo = feature;
  showPhoto(map, feature, recenter);
  showPhotoInfo(feature);
  if (app) refresh(app.set_picture(JSON.stringify(feature)));
}

function showPhotoInfo(feature, message) {
  const section = $("#photo");
  section.replaceChildren(Object.assign(document.createElement("h2"), { textContent: "Photo" }));
  if (!feature) {
    section.append(Object.assign(document.createElement("p"), { className: "aide", textContent: message }));
    return;
  }
  const p = feature.properties || {};
  const accuracy = p["quality:horizontal_accuracy"];
  const rows = [
    ["Date", (p.datetime || "").replace("T", " ").slice(0, 16)],
    ["Producteur", String(p["geovisio:producer"] || "")],
    ["Caméra", (p["pers:interior_orientation"] || {}).camera_model || ""],
    ["Précision GPS", accuracy != null ? `${String(accuracy).replace(".", ",")} m` : ""],
    ["Identifiant", feature.id],
  ];
  const dl = document.createElement("dl");
  for (const [label, value] of rows) {
    dl.append(Object.assign(document.createElement("dt"), { textContent: label }),
      Object.assign(document.createElement("dd"), { textContent: value || "—" }));
  }
  section.append(dl);
}

// Visionneuse ----------------------------------------------------------------------------

/** Branche les clics et les changements de photo, une fois la visionneuse prête. */
function attachViewer() {
  if (psv) return;
  const timer = setInterval(() => {
    if (!viewer.psv) return;
    clearInterval(timer);
    psv = viewer.psv;
    psv.addEventListener("click", (event) => {
      if (!app || event.data.rightclick) return;
      refresh(app.click(event.data.yaw, event.data.pitch));
    });
    // Déplacement dans la séquence (flèches de la visionneuse) : nouvelle fiche de photo
    psv.addEventListener("picture-loaded", async (event) => {
      const id = event.detail?.picId;
      if (!id || id === photo?.id) {
        refresh();
        return;
      }
      try {
        const feature = await photoById(id);
        if (feature) setPhoto(feature, true);
      } catch (error) {
        console.error(error);
      }
    });
    refresh();
  }, 200);
}

const MARK = "mesure-";  // préfixe de nos repères, pour ne pas toucher à ceux de la visionneuse
let markIds = [];

function drawViewerMarks(marks) {
  const markers = psv?.getPlugin?.("markers");
  if (!markers) return;
  for (const id of markIds) {
    try { markers.removeMarker(id, false); } catch { /* déjà retiré */ }
  }
  markIds = [];
  const add = (config) => {
    markers.addMarker(config, false);
    markIds.push(config.id);
  };
  marks.forEach((mark, m) => {
    const points = mark.points.map(([yaw, pitch]) => ({ yaw, pitch }));
    if (points.length >= 2) {
      add({
        id: `${MARK}${m}-trait`, polyline: points.map(({ yaw, pitch }) => [yaw, pitch]),
        svgStyle: { stroke: "#e53935", strokeWidth: "3px", fill: "none" },
      });
    }
    mark.points.forEach(([yaw, pitch, sel], i) => {
      add({
        id: `${MARK}${m}-${i}`, position: { yaw, pitch }, anchor: "center center",
        html: `<div class="croix${sel ? " choisie" : ""}"></div>`,
      });
    });
    if (mark.label) {
      const last = points[points.length - 1];
      add({
        id: `${MARK}${m}-etiquette`, position: last,
        anchor: mark.beside ? "center left" : "bottom center",
        html: `<div class="etiquette">${escapeHtml(mark.label)}</div>`,
      });
    }
  });
  markers.renderMarkers?.();
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Réglages et boutons ----------------------------------------------------------------------

$("#mode").addEventListener("change", (event) => {
  $("#mur").hidden = event.target.value !== "height";
  refresh(app.set_mode(event.target.value));
});
$("#camera").addEventListener("change", (event) => {
  const value = Number(event.target.value);
  if (value >= 0.3 && value <= 6) refresh(app.set_camera_height(value));
});
$("#facade").addEventListener("change", (event) => refresh(app.set_use_wall(event.target.checked)));
$("#effacer").addEventListener("click", () => refresh(app.clear()));
$("#tout-effacer").addEventListener("click", () => refresh(app.clear_all()));
$("#csv").addEventListener("click", () => download("\ufeff" + app.export_csv(), "mesures.csv", "text/csv"));
$("#geojson").addEventListener("click", () => download(app.export_geojson(), "mesures.geojson",
  "application/geo+json"));

// Fichier à enregistrer (le CSV commence par une marque d'ordre des octets : accents lus par les tableurs)
function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Pour les essais depuis la console : window.mesures.app.click(yaw, pitch)
window.mesures = { get app() { return app; }, map, openPhoto };
