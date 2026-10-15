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
  Recherche.attach(map);
  Carte.showMilestones(map);
  let app = null;  // web_app.App, une fois Pyodide chargé
  let photo = null;  // fiche STAC de la photo affichée
  let psv = null;  // visionneuse sphérique (Photo Sphere Viewer) dans <pnx-photo-viewer>
  let savedCalibration = -1;  // version du calage déjà enregistrée dans le navigateur
  let warnedSequence = null;  // séquence pour laquelle le mode dégradé a été signalé
  let noDegradedPopup = false;  // « Ne plus afficher pendant cette session »
  let measuring = false;  // bouton « Mesure » : clics dans la photo pour mesurer, sans navigation

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
  if (!$("#fond").value) $("#fond").value = "plan";  // fond mémorisé qui n'existe plus
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

  // Hauteur de la carte : poignée à glisser (mémorisée), bouton pour la replier --------------

  const mapBox = $("#carte");
  const grip = $("#poignee-carte");
  const fold = $("#replier-carte");
  const narrow = window.matchMedia("(max-width: 900px)");  // carte au-dessus du panneau, sous la photo
  const heightKey = () => (narrow.matches ? "carte-hauteur-etroit" : "carte-hauteur");

  function setMapHeight(px) {
    if (px == null) mapBox.style.removeProperty("height");  // taille par défaut (CSS)
    else mapBox.style.height = `${Math.round(px)}px`;
    map.resize();
  }

  function setFolded(folded) {
    mapBox.hidden = folded;
    grip.classList.toggle("repliee", folded);
    fold.textContent = folded ? "▾" : "▴";
    fold.title = folded ? "Afficher la carte" : "Masquer la carte";
    fold.setAttribute("aria-expanded", String(!folded));
    store.set("carte-repliee", folded ? "1" : "");
    if (!folded) map.resize();
  }

  const applySavedHeight = () => setMapHeight(Number(store.get(heightKey())) || null);
  applySavedHeight();
  narrow.addEventListener("change", applySavedHeight);  // chaque disposition garde sa hauteur
  setFolded(store.get("carte-repliee") === "1");

  fold.addEventListener("click", () => setFolded(!mapBox.hidden));
  fold.addEventListener("pointerdown", (event) => event.stopPropagation());  // pas de glisser
  grip.addEventListener("dblclick", (event) => {
    if (event.target === fold || mapBox.hidden) return;
    store.set(heightKey(), "");
    setMapHeight(null);
  });
  grip.addEventListener("pointerdown", (event) => {
    if (mapBox.hidden) return;
    event.preventDefault();
    const startY = event.clientY, startHeight = mapBox.getBoundingClientRect().height;
    // Limites : 8rem de carte au moins, 6rem de panneau (ou de colonne) au moins
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const room = mapBox.parentElement.getBoundingClientRect().height - grip.offsetHeight;
    const max = narrow.matches ? window.innerHeight * 0.85 : room - 6 * rem;
    const move = (e) => setMapHeight(Math.min(max, Math.max(8 * rem, startHeight + e.clientY - startY)));
    const end = () => {  // suivi sur toute la fenêtre : le pointeur sort vite de la poignée
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      store.set(heightKey(), String(Math.round(mapBox.getBoundingClientRect().height)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  // Largeur de la colonne de droite (grand écran) : poignée à glisser, mémorisée -------------

  const column = $("aside");
  const columnGrip = $("#poignee-colonne");

  function setColumnWidth(px) {
    if (px == null) column.style.removeProperty("width");  // largeur par défaut (CSS)
    else column.style.width = `${Math.round(px)}px`;
    map.resize();
    window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
  }

  if (Number(store.get("colonne-largeur"))) setColumnWidth(Number(store.get("colonne-largeur")));
  columnGrip.addEventListener("dblclick", () => {
    store.set("colonne-largeur", "");
    setColumnWidth(null);
  });
  columnGrip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startX = event.clientX, startWidth = column.getBoundingClientRect().width;
    // Limites : 20rem de colonne au moins, 25 % de la fenêtre au moins pour la photo
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const max = window.innerWidth * 0.75;
    const move = (e) => setColumnWidth(Math.min(max, Math.max(20 * rem, startWidth - (e.clientX - startX))));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      store.set("colonne-largeur", String(Math.round(column.getBoundingClientRect().width)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  /** Route et commune de la photo, incrustées dans la visionneuse (réponse d'une photo déjà
   * quittée ignorée). */
  async function showPlace(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const text = await Lieu.describe(lon, lat);
    if (photo !== feature) return;
    $("#lieu").textContent = text;
    $("#lieu").hidden = !text;
  }

  /** Dernière photo de la visite précédente, rouverte et centrée sur la carte. */
  async function reopenPhoto() {
    const id = store.get("photo");
    if (!id || photo) return;  // rien de gardé, ou photo déjà choisie entre-temps
    try {
      const feature = await Carte.photoById(id);
      if (!feature || photo) return;  // photo supprimée depuis, ou autre photo choisie
      openPhoto(feature);
      map.jumpTo({ center: feature.geometry.coordinates, zoom: 17 });
    } catch (error) {
      console.warn("Dernière photo non rouverte :", error);
    }
  }
  reopenPhoto();

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
    for (const id of ["#mesure", "#mode", "#camera", "#pont", "#effacer", "#tout-effacer", "#calage-exporter",
      "#calage-importer", "#mur", "#viser",
      "#reference", "#longueur"]) $(id).disabled = false;
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

  /** Voyants de la visionneuse, en mode mesure : RTK, LiDAR HD, inclinaison calée. */
  function showLights(lights) {
    const list = $("#voyants");
    list.hidden = !measuring || !lights.length;
    list.replaceChildren(...lights.map(([name, light]) => {
      const item = document.createElement("li");
      item.className = light;
      item.textContent = name;
      return item;
    }));
    // Inclinaison : calcul en cours, ou calcul automatique sans résultat (calage à la main
    // conseillé, sauf pendant ce calage)
    const tilt = (lights.find(([name]) => name === "Inclinaison") || [])[1];
    const message = $("#calcul-inclinaison");
    // En calage de l'inclinaison, rappel du mode : les clics calent la photo, ils ne mesurent pas
    const calibrating = $("#mode").value === "tilt";
    const triangulating = $("#mode").value === "tri";  // pas de calcul d'inclinaison (visée en cap)
    const manual = tilt === "non" && !calibrating;
    message.hidden = !measuring || triangulating || !(calibrating || tilt === "attente" || manual);
    message.classList.toggle("manuel", manual);
    message.classList.toggle("calage", calibrating);
    message.classList.toggle("attente", tilt === "attente");  // petite roue : calcul en cours
    if (tilted !== (tilt === "ok")) {
      tilted = tilt === "ok";
      applyMeasureUi();  // pointeur : cercle vert
    }
    message.textContent = calibrating
      ? "Calage vertical" + (tilt === "attente" ? " · calcul automatique en cours" : "")
      : manual
        ? "Pour plus de précision, calez l'inclinaison à la main (mode « Calage : inclinaison »)"
        : "Calcul du calage de l'inclinaison en cours";
  }

  // Message du calcul d'inclinaison : sous le pointeur de mesure tant qu'il est dans la vue,
  // sous le centre de la vue sinon
  $("#vue").addEventListener("pointermove", (event) => {
    const box = $("#vue").getBoundingClientRect();
    const message = $("#calcul-inclinaison");
    message.style.left = `${event.clientX - box.left}px`;
    message.style.top = `${event.clientY - box.top + 24}px`;
  }, { capture: true });
  $("#vue").addEventListener("pointerleave", () => {
    const message = $("#calcul-inclinaison");
    message.style.left = message.style.top = "";
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
    showLights(state.lights);
    $("#garder").disabled = !state.point;
    const bandeau = $("#bandeau");
    bandeau.hidden = !state.waiting_map;
    bandeau.textContent = "Cliquez maintenant ce repère sur la carte (Échap pour annuler).";
    map.getCanvas().style.cursor = state.waiting_map ? "crosshair" : "";
    if (state.active) warnIfDegraded(state);
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

  let resultsKey = "";  // résultats affichés (sans les commentaires, que l'on est peut-être en train d'écrire)

  function showResults(list) {
    const key = JSON.stringify(list.map((r) => [r.kind, r.id, r.text]));
    if (key === resultsKey) return;
    resultsKey = key;
    const ol = $("#resultats ol");
    const focused = document.activeElement?.closest?.("#resultats ol") ? document.activeElement.dataset.key : null;
    ol.replaceChildren(...list.map((r) => {
      const li = document.createElement("li");
      const text = Object.assign(document.createElement("span"), { textContent: r.text });
      const comment = Object.assign(document.createElement("input"), {
        type: "text", value: r.comment, placeholder: "Commentaire", title: "Commentaire exporté avec le résultat",
      });
      comment.dataset.key = `${r.kind}-${r.id}`;
      comment.addEventListener("input", () => app.set_comment(r.kind, r.id, comment.value));
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
    // Séquence et photo ensemble : la visionneuse garde sinon la séquence de la photo précédente,
    // n'y trouve pas la nouvelle photo et se vide
    if (viewer.getAttribute("picture") !== feature.id) {
      if (viewer.select) viewer.select(feature.collection || null, feature.id, true);
      else viewer.setAttribute("picture", feature.id);
    }
    attachViewer();
  }

  function setPhoto(feature, recenter) {
    photo = feature;
    store.set("photo", feature.id);  // rouverte à la prochaine visite (voir reopenPhoto)
    showPlace(feature);
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
      // Pendant une mesure, le clic ne va pas à la visionneuse (elle irait à la photo voisine
      // dans la direction cliquée, ou suivrait une flèche) : il devient un point de mesure.
      const dispatch = psv.dispatchEvent;
      psv.dispatchEvent = function (event) {
        if (event?.type === "click" && blocksNavigation()) {
          if (app && !event.data?.rightclick) {
            refresh(photoReady() ? app.click(event.data.yaw, event.data.pitch) : LOADING);
          }
          return true;
        }
        return dispatch.call(this, event);
      };
      psv.addEventListener("position-updated", updateCursor);
      psv.addEventListener("zoom-updated", updateCursor);
      // Déplacement dans la séquence (flèches de la visionneuse) : nouvelle fiche de photo
      psv.addEventListener("picture-loaded", async (event) => {
        applyMeasureUi();  // flèches de la nouvelle photo
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
      applyMeasureUi();
      refresh();
      updateCursor();
    }, 200);
  }

  // Bouton « Mesure » ------------------------------------------------------------------------

  /**
   * La visionneuse montre-t-elle la photo dont le calcul a la fiche ? Pendant un changement de
   * photo, l'une ou l'autre est en retard : un clic mêlerait la direction d'une photo et la
   * position de l'autre (comme le plugin, on le refuse).
   */
  function photoReady() {
    if (!psv || !photo) return false;
    // Photo affichée (getPictureId donnerait celle en cours de chargement)
    const shown = psv.getPictureMetadata?.()?.id;
    return shown === photo.id;
  }
  const LOADING = "Photo en cours de chargement : cliquez à nouveau.";

  /** Les clics dans la photo mesurent (pas en triangulation, qui demande de changer de photo). */
  function blocksNavigation() {
    return measuring && $("#mode").value !== "tri";
  }

  // Pointeur de mesure : réticule fin (comme le plugin), la visionneuse imposant sinon main ou flèche
  // Cercle extérieur jaune, vert une fois l'inclinaison de la photo calée (voir showLights)
  const cursorCss = (tilted) => `.psv-container, .psv-container * { cursor: url("data:image/svg+xml;utf8,${
    encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='33' height='33'>"
      + `<circle cx='16.5' cy='16.5' r='15' fill='none' stroke='${tilted ? "#2ecc40" : "#ffeb00"}' stroke-width='2.5'/>`
      + "<path d='M16.5 2v11M16.5 20v11M2 16.5h11M20 16.5h11' stroke='#ff8a80' stroke-width='1.5'/>"
      + "<circle cx='16.5' cy='16.5' r='1' fill='white'/></svg>")}") 16 16, crosshair !important; }`;
  let tilted = false;  // inclinaison de la photo affichée calée

  /** Navigation, flèches, curseur au sol et pointeur de la visionneuse selon le bouton « Mesure ». */
  function applyMeasureUi() {
    $("#mesure").setAttribute("aria-pressed", String(measuring));
    $("#mesure").classList.toggle("actif", measuring);
    $("#mode-mesure").hidden = !measuring;
    showModeOptions();
    const box = psv?.container;
    if (!box) return;
    const block = blocksNavigation();
    for (const arrows of box.querySelectorAll(".psv-virtual-tour-arrows")) {
      if (block) arrows.style.setProperty("visibility", "hidden", "important");
      else arrows.style.removeProperty("visibility");
    }
    // Curseur « aller ici » qui suit la souris sur le sol : image du moteur 360°, sans souris
    for (const img of box.querySelectorAll(":scope > img")) {
      if (img.style.pointerEvents !== "none" || img.style.position !== "absolute") continue;
      if (measuring) img.style.setProperty("visibility", "hidden", "important");
      else img.style.removeProperty("visibility");
    }
    const root = box.getRootNode();
    let style = root.getElementById ? root.getElementById("mesure-pointeur") : null;
    if (block && !style) {
      style = Object.assign(document.createElement("style"), { id: "mesure-pointeur" });
      (root === document ? document.head : root).append(style);
    } else if (!block && style) {
      style.remove();
    }
    if (style?.isConnected) {
      const css = cursorCss(tilted);
      if (style.textContent !== css) style.textContent = css;
    }
  }

  $("#mesure").addEventListener("click", () => {
    measuring = !measuring;
    if (measuring) warnedSequence = null;  // mode dégradé signalé à nouveau, comme le plugin
    applyMeasureUi();
    refresh(app.set_active(measuring));
  });

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
      if (mark.label) {  // au milieu du trait, un peu au-dessus (à côté pour une hauteur)
        // Repère de taille nulle au milieu du trait, étiquette décalée d'un nombre fixe de pixels
        // par le CSS : la visionneuse mesure la taille d'un repère une seule fois, parfois avant
        // sa mise en page, et l'ancrerait alors trop loin
        add({
          id: `${MARK}${m}-etiquette`, position: middle(points), anchor: "center center",
          html: `<div class="ancre"><div class="etiquette ${mark.beside ? "cote" : "dessus"}">${
            escapeHtml(mark.label)}</div></div>`,
        });
      }
    });
    markers.renderMarkers?.();
  }

  /**
   * Milieu d'un trait dans la photo (cap et élévation en radians). La visionneuse le dessine
   * droit à l'écran : c'est le grand cercle entre les deux visées, dont le milieu est la somme
   * des deux directions. La moyenne des caps et des élévations tomberait au-dessus du trait
   * dès qu'il est long (largeur de chaussée).
   */
  function middle(points) {
    const dir = ({ yaw, pitch }) => [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
    const a = dir(points[0]), b = dir(points[points.length - 1]);
    const [x, y, z] = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    return { yaw: Math.atan2(x, z), pitch: Math.atan2(y, Math.hypot(x, z)) };
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  // Mode et réglages de la mesure ----------------------------------------------------------

  function showModeOptions() {
    const mode = $("#mode").value;
    for (const option of document.querySelectorAll("header .option")) {
      const modes = option.dataset.modes.split(" ");
      option.hidden = !modes.includes(mode);
    }
    $("#reticule").hidden = mode !== "tri" || !measuring || viewer.hidden;
  }

  $("#mode").addEventListener("change", (event) => {
    applyMeasureUi();  // triangulation : navigation rétablie
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
  for (const id of ["#reference", "#longueur"]) {
    $(id).addEventListener("change", () => refresh(app.set_reference($("#reference").value, Number($("#longueur").value))));
  }
  $("#viser").addEventListener("click", () => {
    if (!psv) {
      setStatus("Aucune photo affichée : impossible de viser.");
      return;
    }
    if (!photoReady()) {
      setStatus(LOADING);
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

  let exported = "[]";  // résultats (commentaires compris) lors du dernier export

  $("#csv").addEventListener("click", () => {
    download("\ufeff" + app.export_csv(), "mesures.csv", "text/csv");
    exported = app.results();
  });
  $("#geojson").addEventListener("click", () => {
    download(app.export_geojson(), "mesures.geojson", "application/geo+json");
    exported = app.results();
  });
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
    if (app && app.has_results() && app.results() !== exported) event.preventDefault();  // non exportés
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
      // Cartouches (attribution, localisation) dessinés ici : polices du navigateur, accents compris
      const image = new Image();
      image.src = `data:image/jpeg;base64,${jpeg}`;
      await image.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      drawCartouches(ctx, canvas, Math.max(14, Math.round(canvas.height / 54)), params.caption, placeText());
      download(await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92)), `${params.name}.jpg`);
    } catch (error) {
      setStatus(`Capture « Image seule » impossible : ${error.message}`, "echec");
    } finally {
      button.disabled = false;
      button.textContent = "📷 Image seule";
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
      setStatus(`Capture « Avec les mesures » impossible : ${error.message}`, "echec");
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
      const centre = middle(mark.points.map(([yaw, pitch]) => ({ yaw, pitch })));
      const mid = mark.label ? screen([centre.yaw, centre.pitch]) : null;
      if (mid && mark.beside) label(ctx, mark.label, mid[0] + 9 * scale, mid[1] + 9 * scale, 12 * scale, "left");
      else if (mid) label(ctx, mark.label, mid[0], mid[1] - 7 * scale, 12 * scale, "center");
    }
    const caption = app ? app.caption(psv.getPosition().yaw) : "Panoramax";
    drawCartouches(ctx, canvas, 12 * scale, caption, placeText());
    return canvas;
  }

  /** Cartouches d'une capture : attribution en bas à droite, localisation en bas à gauche,
   * ou au-dessus de l'attribution si elles ne tiennent pas côte à côte. */
  function drawCartouches(ctx, canvas, size, caption, place) {
    const margin = size * 0.7;
    const bottom = canvas.height - margin;
    const width = (text, s) => {
      ctx.font = `${s}px system-ui, sans-serif`;
      return text ? ctx.measureText(text).width + s : 0;
    };
    // Texte plus large que l'image (vue étroite) : réduit pour tenir dans la largeur
    const fit = (text) => Math.min(size, size * (canvas.width - 2 * margin) / Math.max(width(text, size), 1));
    const captionSize = fit(caption), placeSize = fit(place);
    if (caption) label(ctx, caption, canvas.width - margin, bottom, captionSize, "right");
    if (!place) return;
    const side = width(place, placeSize) + width(caption, captionSize) + 3 * margin <= canvas.width;
    label(ctx, place, margin, side ? bottom : bottom - captionSize * 1.6 - margin / 2, placeSize, "left");
  }

  /** Localisation affichée dans la visionneuse (route, PR, commune), ou "". */
  function placeText() {
    return $("#lieu").hidden ? "" : $("#lieu").textContent;
  }

  function label(ctx, text, x, y, size, align) {
    ctx.font = `${size}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + size;
    const left = align === "right" ? x - w : align === "left" ? x : x - w / 2;
    ctx.fillStyle = "rgba(32, 33, 36, 0.85)";
    ctx.fillRect(left, y - size * 1.4, w, size * 1.6);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + size / 2, y - size * 0.6);
  }

  // Pour les essais depuis la console : window.mesures.app.click(yaw, pitch)
  window.mesures = { get app() { return app; }, get psv() { return psv; }, map, openPhoto };
})();
