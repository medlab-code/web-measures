// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Page de mesure : la carte choisit la photo, la visionneuse Panoramax reçoit les clics,
// le cœur de calcul du plugin (Pyodide, voir calcul.js) fait les mesures et les calages.
// Mêmes fonctions que le plugin QGIS Visionneuse Panoramax.

(() => {
  const $ = (selector) => document.querySelector(selector);
  const viewer = $("#visionneuse");
  const map = Carte.createMap("carte");
  let app = null;  // web_app.App, une fois Pyodide chargé
  let photo = null;  // fiche STAC de la photo affichée
  let psv = null;  // visionneuse sphérique (Photo Sphere Viewer) dans <pnx-photo-viewer>
  let savedCalibration = -1;  // version du calage déjà enregistrée dans le navigateur
  let warnedSequence = null;  // séquence pour laquelle le mode dégradé a été signalé
  let noDegradedPopup = false;  // « Ne plus afficher pendant cette session »

  // Réglages gardés dans le navigateur (facultatif : navigation privée, stockage bloqué…)
  const store = {
    get(key, fallback = null) {
      try {
        const value = localStorage.getItem(`web-measures/${key}`);
        return value === null ? fallback : value;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(`web-measures/${key}`, value); } catch { /* sans stockage */ }
    },
  };

  Services.checkServices($("#reseau ul"));

  // Fond, instance, centrage ----------------------------------------------------------------

  $("#fond").value = store.get("fond", "plan");
  map.on("load", () => Carte.setBackground(map, $("#fond").value));
  $("#fond").addEventListener("change", (event) => {
    Carte.setBackground(map, event.target.value);
    store.set("fond", event.target.value);
  });
  $("#centrer").checked = store.get("centrer", "1") === "1";
  $("#centrer").addEventListener("change", (event) => store.set("centrer", event.target.checked ? "1" : "0"));

  const instance = $("#instance");
  instance.append(new Option("Toutes les instances (méta-catalogue)", ""));
  const savedInstance = store.get("instance", "");
  if (savedInstance) instance.append(new Option(savedInstance, savedInstance));
  instance.value = savedInstance;
  let apiUrl = Carte.setInstance(map, savedInstance);
  viewer.setAttribute("endpoint", apiUrl);
  Carte.instances().then((list) => {
    for (const [name, url] of list) {
      if (url !== savedInstance) instance.append(new Option(name, url));
      else instance.options[1].text = name;
    }
  }).catch((error) => console.warn("Instances Panoramax :", error));
  instance.addEventListener("change", () => {
    store.set("instance", instance.value);
    apiUrl = Carte.setInstance(map, instance.value);
    viewer.setAttribute("endpoint", apiUrl);
    app?.set_api_url(apiUrl);
  });

  // Calcul ---------------------------------------------------------------------------------

  function setStatus(text, kind = "") {
    const status = $("#statut");
    status.textContent = text;
    status.className = "statut " + kind;
  }

  Calcul.startCalcul(() => refresh(), apiUrl).then((created) => {
    app = created;
    const saved = store.get("calage");
    if (saved && !app.load_calibration(saved)) console.warn("Calage enregistré illisible : ignoré.");
    savedCalibration = app.calibration_version;
    for (const id of ["#mode", "#camera", "#pont", "#effacer", "#tout-effacer", "#calage-exporter",
      "#calage-importer"]) $(id).disabled = false;
    $("#camera").value = store.get("camera", $("#camera").value);
    app.set_camera_height(Number($("#camera").value));
    applyFilter(false);
    if (photo) app.set_picture(JSON.stringify(photo));
    showModeOptions();
    refresh();
  }).catch((error) => {
    console.error(error);
    setStatus(`Calcul indisponible : ${error.message}`, "echec");
  });

  /** Redessine tout : texte de la mesure, état de la photo, repères, carte, résultats. */
  function refresh(text) {
    if (!app) return;
    setStatus(text ?? app.status());
    const state = JSON.parse(app.state());
    $("#qualite").textContent = state.quality;
    $("#qualite").classList.toggle("alerte", state.quality.startsWith("⚠"));
    $("#calage").textContent = state.calibration;
    const gps = $("#camera-gps");
    gps.hidden = !state.camera;
    if (state.camera) {
      gps.textContent = `Caméra à ${String(state.camera[0]).replace(".", ",")} m d'après l'altitude GPS : utiliser`;
      gps.title = state.camera[1];
      gps.dataset.value = state.camera[0];
    }
    $("#garder").disabled = !state.point;
    const bandeau = $("#bandeau");
    bandeau.hidden = !state.waiting_map;
    bandeau.textContent = "Cliquez maintenant ce repère sur la carte (Échap pour annuler).";
    map.getCanvas().style.cursor = state.waiting_map ? "crosshair" : "";
    warnIfDegraded(state);
    const height = app.take_camera_height();
    if (height != null) {  // hauteur de caméra calée : reportée dans le réglage
      $("#camera").value = Math.min(6, Math.max(0.3, height)).toFixed(2);
      setCamera();
    }
    if (app.calibration_version !== savedCalibration) {
      savedCalibration = app.calibration_version;
      store.set("calage", app.calibration_json());
    }
    drawViewerMarks(JSON.parse(app.viewer_marks()));
    Carte.showMeasures(map, JSON.parse(app.map_geojson()));
    Carte.showHandles(map, JSON.parse(app.handles()), (index, lon, lat) => refresh(app.move_handle(index, lon, lat)));
    showResults(JSON.parse(app.results()));
    const results = app.has_results();
    $("#csv").disabled = !results;
    $("#geojson").disabled = !results;
  }

  function warnIfDegraded(state) {
    const sequence = photo?.collection ?? photo?.id;
    if (!state.degraded.length || noDegradedPopup || sequence === warnedSequence) return;
    warnedSequence = sequence;
    const dialog = $("#degrade");
    dialog.querySelector("ul").replaceChildren(...state.degraded.map((r) => Object.assign(
      document.createElement("li"), { textContent: r })));
    dialog.querySelector(".aide").textContent = state.advice;
    dialog.querySelector("input[name=plus]").checked = false;
    if (!dialog.open) dialog.showModal();
  }
  $("#degrade").addEventListener("close", () => {
    noDegradedPopup = $("#degrade input[name=plus]").checked;
  });

  // Résultats ------------------------------------------------------------------------------

  function showResults(list) {
    const ol = $("#resultats ol");
    const focused = document.activeElement?.closest?.("#resultats ol") ? document.activeElement.dataset.key : null;
    ol.replaceChildren(...list.map((r) => {
      const li = document.createElement("li");
      const text = Object.assign(document.createElement("span"), { textContent: r.text });
      const comment = Object.assign(document.createElement("input"), {
        type: "text", value: r.comment, placeholder: "Commentaire", title: "Commentaire exporté avec le résultat",
      });
      comment.dataset.key = `${r.kind}-${r.id}`;
      comment.addEventListener("change", () => app.set_comment(r.kind, r.id, comment.value));
      li.append(text, comment);
      return li;
    }));
    if (focused) ol.querySelector(`[data-key="${focused}"]`)?.focus();
  }

  // Choix de la photo sur la carte ---------------------------------------------------------

  map.on("click", async (event) => {
    const { lng, lat } = event.lngLat;
    if (app && app.map_click(lng, lat)) {  // repère du calage du cap
      refresh();
      return;
    }
    showPhotoInfo(null, "Recherche de la photo la plus proche…");
    try {
      const accept = app ? (feature) => app.filter_matches(JSON.stringify(feature)) : undefined;
      const feature = await Carte.nearestPhoto(map, lng, lat, accept);
      if (!feature) {
        const filtered = app && app.filter_text();
        showPhotoInfo(null, filtered ? `Aucune photo près de ce point avec le filtre (${filtered}).`
          : "Aucune photo près de ce point : cliquez sur le filaire orange.");
        return;
      }
      openPhoto(feature);
    } catch (error) {
      showPhotoInfo(null, `Recherche impossible : ${error.message}`);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app && app.waiting_map()) refresh(app.cancel_landmark());
  });

  function openPhoto(feature) {
    setPhoto(feature, false);
    $("#invite").hidden = true;
    viewer.hidden = false;
    if (viewer.getAttribute("picture") !== feature.id) viewer.setAttribute("picture", feature.id);
    attachViewer();
  }

  function setPhoto(feature, recenter) {
    photo = feature;
    const coords = feature.geometry.coordinates;
    Carte.showView(map, coords, viewHeading(), viewFov());
    if (recenter && $("#centrer").checked) map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 17) });
    showPhotoInfo(feature);
    $("#capture-hd").disabled = !Calcul.hasWorker();
    $("#vignette").disabled = false;
    if (app) refresh(app.set_picture(JSON.stringify(feature)));
    updateProducers();
  }

  function showPhotoInfo(feature, message) {
    const section = $("#fiche");
    if (!feature) {
      section.replaceChildren(Object.assign(document.createElement("p"), { className: "aide", textContent: message }));
      return;
    }
    const p = feature.properties || {};
    const accuracy = p["quality:horizontal_accuracy"];
    const rows = [
      ["Date", (p.datetime || "").replace("T", " ").slice(0, 16)],
      ["Producteur", ((p.providers || feature.providers || []).find((x) => (x.roles || []).includes("producer")) || {}).name
        || String(p["geovisio:producer"] || "")],
      ["Caméra", (p["pers:interior_orientation"] || {}).camera_model || ""],
      ["Précision GPS", accuracy != null ? `${String(accuracy).replace(".", ",")} m` : ""],
      ["Identifiant", feature.id],
    ];
    const dl = document.createElement("dl");
    for (const [label, value] of rows) {
      dl.append(Object.assign(document.createElement("dt"), { textContent: label }),
        Object.assign(document.createElement("dd"), { textContent: value || "—" }));
    }
    section.replaceChildren(dl);
  }

  // Visionneuse ----------------------------------------------------------------------------

  /** Cap (degrés) du centre de la vue affichée, ou null. La visionneuse s'oriente sur view:azimuth. */
  function viewHeading() {
    if (!photo) return null;
    const azimuth = photo.properties?.["view:azimuth"];
    if (azimuth == null) return null;
    const yaw = psv ? psv.getPosition().yaw : 0;
    return (yaw * 180 / Math.PI + Number(azimuth) + 360) % 360;
  }

  /** Champs de vision de la vue (degrés) : horizontal (fov) ou vertical. */
  function viewFov(vertical = false) {
    const state = psv?.state || {};
    const value = vertical ? state.vFov : state.hFov;
    if (typeof value === "number" && value > 0) return value;
    return vertical ? 60 : 90;
  }

  function updateCursor() {
    if (photo) Carte.showView(map, photo.geometry.coordinates, viewHeading(), viewFov());
  }

  /** Branche les clics, la vue et les changements de photo, une fois la visionneuse prête. */
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
      psv.addEventListener("position-updated", updateCursor);
      psv.addEventListener("zoom-updated", updateCursor);
      // Déplacement dans la séquence (flèches de la visionneuse) : nouvelle fiche de photo
      psv.addEventListener("picture-loaded", async (event) => {
        const id = event.detail?.picId;
        if (!id || id === photo?.id) {
          refresh();
          return;
        }
        try {
          const feature = await Carte.photoById(id);
          if (feature) setPhoto(feature, true);
        } catch (error) {
          console.error(error);
        }
      });
      refresh();
      updateCursor();
    }, 200);
  }

  const MARK = "mesure-";  // préfixe de nos repères, pour ne pas toucher à ceux de la visionneuse
  let markIds = [];
  let currentMarks = [];

  function drawViewerMarks(marks) {
    currentMarks = marks;
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
        add({
          id: `${MARK}${m}-etiquette`, position: points[points.length - 1],
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

  // Mode et réglages de la mesure ----------------------------------------------------------

  function showModeOptions() {
    const mode = $("#mode").value;
    const surface = $("#surface").value;
    for (const option of document.querySelectorAll("header .option")) {
      const modes = option.dataset.modes.split(" ");
      option.hidden = !modes.includes(mode) || (option.dataset.surface && option.dataset.surface !== surface);
    }
    $("#reticule").hidden = mode !== "tri" || viewer.hidden;
  }

  $("#mode").addEventListener("change", (event) => {
    showModeOptions();
    refresh(app.set_mode(event.target.value));
  });
  function setCamera() {
    const value = Number($("#camera").value);
    if (value >= 0.3 && value <= 6) {
      store.set("camera", $("#camera").value);
      refresh(app.set_camera_height(value));
    }
  }
  $("#camera").addEventListener("change", setCamera);
  $("#camera-gps").addEventListener("click", (event) => {
    $("#camera").value = Number(event.target.dataset.value).toFixed(2);
    setCamera();
  });
  $("#pont").addEventListener("change", (event) => refresh(app.set_bridge(event.target.checked)));
  $("#mur").addEventListener("change", (event) => refresh(app.set_use_wall(event.target.checked)));
  $("#surface").addEventListener("change", (event) => {
    showModeOptions();
    refresh(app.set_surface(event.target.value));
  });
  $("#plan").addEventListener("change", (event) => refresh(app.set_plane_height(Number(event.target.value))));
  $("#definir-facade").addEventListener("click", () => refresh(app.start_facade()));
  $("#facade-cadastre").addEventListener("click", () => refresh(app.start_wall_facade()));
  for (const id of ["#reference", "#longueur"]) {
    $(id).addEventListener("change", () => refresh(app.set_reference($("#reference").value, Number($("#longueur").value))));
  }
  $("#viser").addEventListener("click", () => {
    if (!psv) {
      setStatus("Aucune photo affichée : impossible de viser.");
      return;
    }
    const { yaw, pitch } = psv.getPosition();
    refresh(app.aim(yaw, pitch));
  });
  $("#garder").addEventListener("click", () => refresh(app.keep_point()));
  $("#effacer").addEventListener("click", () => refresh(app.clear()));
  $("#tout-effacer").addEventListener("click", () => refresh(app.clear_all()));
  new MutationObserver(showModeOptions).observe(viewer, { attributes: true, attributeFilter: ["hidden"] });

  // Filtre des photos -----------------------------------------------------------------------

  function currentFilter() {
    const producer = $("#producteur").value;
    return {
      since: $("#depuis").value || null,
      kind: $("#type").value || null,
      max_gps: $("#gps").value ? Number($("#gps").value) : null,
      producer: producer ? JSON.parse(producer) : null,
    };
  }

  function applyFilter(save = true) {
    const f = currentFilter();
    if (save) store.set("filtre", JSON.stringify(f));
    Carte.setFilter(map, f);
    if (app) app.set_filter(JSON.stringify(f));
    const active = Object.values(f).some((v) => v != null);
    $("#filtre-actif").textContent = active ? "●" : "";
    $("#filtre-actif").title = active && app ? app.filter_text() : "";
  }

  function addProducer(producer) {
    const value = JSON.stringify(producer);
    if (![...$("#producteur").options].some((o) => o.value === value)) {
      $("#producteur").append(new Option(producer[1], value));
    }
  }

  function updateProducers() {
    const producer = app ? JSON.parse(app.producer()) : null;
    if (producer) addProducer(producer);
  }

  try {
    const saved = JSON.parse(store.get("filtre", "{}")) || {};
    $("#depuis").value = saved.since || "";
    $("#type").value = saved.kind || "";
    $("#gps").value = saved.max_gps != null ? String(saved.max_gps) : "";
    if (saved.producer) {
      addProducer(saved.producer);
      $("#producteur").value = JSON.stringify(saved.producer);
    }
  } catch { /* filtre enregistré illisible : aucun */ }
  map.on("load", () => applyFilter(false));
  for (const id of ["#depuis", "#type", "#gps", "#producteur"]) $(id).addEventListener("change", () => applyFilter());

  // Exports ----------------------------------------------------------------------------------

  $("#csv").addEventListener("click", () => download("﻿" + app.export_csv(), "mesures.csv", "text/csv"));
  $("#geojson").addEventListener("click", () => download(app.export_geojson(), "mesures.geojson",
    "application/geo+json"));
  $("#calage-exporter").addEventListener("click", () => download(app.calibration_json(), "calage-panoramax.json",
    "application/json"));
  $("#calage-importer").addEventListener("click", () => $("#calage-fichier").click());
  $("#calage-fichier").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const added = app.merge_calibration(await file.text());
    refresh(added < 0 ? "Fichier de calage illisible." : added === 0
      ? "Calage importé : rien de nouveau (photos et séquences déjà calées)."
      : `Calage importé pour ${added} photo${added > 1 ? "s" : ""} ou séquence${added > 1 ? "s" : ""}.`);
  });

  // Fichier à enregistrer (le CSV commence par une marque d'ordre des octets : accents lus par les tableurs)
  function download(content, name, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.addEventListener("beforeunload", (event) => {
    if (app && app.has_results()) event.preventDefault();  // mesures non exportées
  });

  // Captures ----------------------------------------------------------------------------------

  $("#capture-hd").addEventListener("click", async () => {
    if (!app || !psv) return;
    const { yaw, pitch } = psv.getPosition();
    const text = app.capture_args(yaw, pitch, viewFov(true));
    if (!text) {
      setStatus("Pas de photo HD pour cette photo : capture impossible.");
      return;
    }
    const params = JSON.parse(text);
    const button = $("#capture-hd");
    button.disabled = true;
    button.textContent = "📷 Capture en cours…";
    try {
      const response = await fetch(params.href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const jpeg = await Calcul.capture(params, new Uint8Array(await response.arrayBuffer()));
      if (!jpeg) throw new Error("format d'image non reconnu");
      const bytes = Uint8Array.from(atob(jpeg), (c) => c.charCodeAt(0));
      download(new Blob([bytes], { type: "image/jpeg" }), `${params.name}.jpg`);
    } catch (error) {
      setStatus(`Capture HD impossible : ${error.message}`, "echec");
    } finally {
      button.disabled = false;
      button.textContent = "📷 Capture HD";
    }
  });

  $("#vignette").addEventListener("click", async () => {
    if (!psv) return;
    try {
      const canvas = thumbnail();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const date = (photo?.properties?.datetime || "").replace(/[^0-9]/g, "").slice(0, 8) || "sansdate";
      download(blob, `panoramax_vignette_${date}_${(photo?.id || "").slice(0, 8)}.png`);
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setStatus("Vignette enregistrée et copiée dans le presse-papiers.");
      } catch {
        setStatus("Vignette enregistrée (copie dans le presse-papiers refusée par le navigateur).");
      }
    } catch (error) {
      setStatus(`Capture vignette impossible : ${error.message}`, "echec");
    }
  });

  /** La visionneuse telle qu'affichée, avec les repères des mesures et l'attribution. */
  function thumbnail() {
    const r = psv.renderer;
    r.renderer.render(r.scene, r.camera);  // image WebGL lue juste après son rendu
    const gl = r.renderer.domElement;
    const canvas = document.createElement("canvas");
    canvas.width = gl.width;
    canvas.height = gl.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(gl, 0, 0);
    const scale = gl.width / gl.clientWidth;
    const view = psv.getPosition();
    const screen = ([yaw, pitch]) => {
      // Point derrière la vue : pas dessiné
      const cos = Math.sin(pitch) * Math.sin(view.pitch)
        + Math.cos(pitch) * Math.cos(view.pitch) * Math.cos(yaw - view.yaw);
      if (cos <= 0.05) return null;
      const p = psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch });
      return [p.x * scale, p.y * scale];
    };
    ctx.lineCap = "round";
    for (const mark of currentMarks) {
      const pts = mark.points.map(screen);
      ctx.strokeStyle = "#e53935";
      ctx.lineWidth = 3 * scale;
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) continue;
        ctx.beginPath();
        ctx.moveTo(...pts[i - 1]);
        ctx.lineTo(...pts[i]);
        ctx.stroke();
      }
      for (const p of pts) {
        if (!p) continue;
        for (const [color, width] of [["rgba(0,0,0,0.7)", 4], ["#ffeb00", 2]]) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width * scale;
          ctx.beginPath();
          ctx.moveTo(p[0] - 9 * scale, p[1]);
          ctx.lineTo(p[0] + 9 * scale, p[1]);
          ctx.moveTo(p[0], p[1] - 9 * scale);
          ctx.lineTo(p[0], p[1] + 9 * scale);
          ctx.stroke();
        }
      }
      const last = pts[pts.length - 1];
      if (mark.label && last) label(ctx, mark.label, last[0], last[1] - 14 * scale, 12 * scale, "center");
    }
    const caption = app ? app.caption(psv.getPosition().yaw) : "Panoramax";
    label(ctx, caption, canvas.width - 8 * scale, canvas.height - 8 * scale, 12 * scale, "right");
    return canvas;
  }

  function label(ctx, text, x, y, size, align) {
    ctx.font = `${size}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + size;
    const left = align === "right" ? x - w : x - w / 2;
    ctx.fillStyle = "rgba(32, 33, 36, 0.85)";
    ctx.fillRect(left, y - size * 1.4, w, size * 1.6);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + size / 2, y - size * 0.6);
  }

  // Pour les essais depuis la console : window.mesures.app.click(yaw, pitch)
  window.mesures = { get app() { return app; }, get psv() { return psv; }, map, openPhoto };
})();
