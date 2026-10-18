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
  Requeteur.attach(map, openNearest);
  Carte.showMilestones(map);
  let app = null;  // web_app.App, une fois Pyodide chargé
  let photo = null;  // fiche STAC de la photo affichée
  let psv = null;  // visionneuse sphérique (Photo Sphere Viewer) dans <pnx-photo-viewer>
  let savedCalibration = -1;  // version du calage déjà enregistrée dans le navigateur
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
  // Police des cartouches prête avant qu'ils ne soient dessinés
  document.fonts?.load("700 24px Roboto").catch(() => {});
  Carte.showAdmin(map);  // limites administratives (fond « orthophoto avec noms »)
  // Filaire Panoramax affiché ou non (choix mémorisé)
  $("#filaire").checked = store.get("filaire", "1") === "1";
  map.on("load", () => Carte.setNetworkVisible(map, $("#filaire").checked));
  $("#filaire").addEventListener("change", (event) => {
    Carte.setNetworkVisible(map, event.target.checked);
    store.set("filaire", event.target.checked ? "1" : "0");
  });
  $("#fond").addEventListener("change", (event) => {
    Carte.setBackground(map, event.target.value);
    store.set("fond", event.target.value);
  });
  $("#centrer").checked = store.get("centrer", "1") === "1";
  $("#centrer").addEventListener("change", (event) => store.set("centrer", event.target.checked ? "1" : "0"));

  // Réglages par défaut : l'instance de l'IGN et les photos du conseil départemental de la
  // Côte-d'Or (positions RTK, LiDAR HD : ce que demandent les calculs). Appliqués une fois, même
  // dans un navigateur qui avait déjà ses réglages ; chacun peut ensuite en changer.
  const DEFAULT_INSTANCE = "https://panoramax.ign.fr";
  const DEFAULT_PRODUCER = ["8f943f10-a781-4e03-a18c-de035be6f6f8", "conseil départemental de la côte-d'or"];
  // Photo ouverte à la première utilisation (et sans dernière photo gardée), regard vers l'ouest
  const DEFAULT_PHOTO = "88eba563-792a-447f-92c5-215e749ffc9b";
  const DEFAULT_HEADING = 270;
  const firstUse = store.get("defauts") !== "1";
  if (firstUse) {
    $("#reglages-defaut").showModal();  // pourquoi ces réglages, et où les changer
    store.set("instance", DEFAULT_INSTANCE);
    let filter = {};
    try { filter = JSON.parse(store.get("filtre", "{}")) || {}; } catch { /* illisible : remplacé */ }
    store.set("filtre", JSON.stringify({ ...filter, producer: DEFAULT_PRODUCER }));
    store.set("defauts", "1");
  }

  const instance = $("#instance");
  instance.append(new Option("Toutes les instances (méta-catalogue)", ""));
  const savedInstance = store.get("instance", DEFAULT_INSTANCE);
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
    checkPhoto();
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
  const columnFold = $("#replier-colonne");

  /** Colonne de droite (carte et panneau) masquée ou affichée ; mémorisé. */
  function setColumnFolded(folded) {
    column.hidden = folded;
    columnGrip.classList.toggle("repliee", folded);
    const below = narrow.matches;  // colonne sous la photo : flèches vers le bas et le haut
    columnFold.textContent = folded ? (below ? "▴" : "◂") : (below ? "▾" : "▸");
    columnFold.title = folded ? "Afficher la carte et le panneau" : "Masquer la carte et le panneau";
    columnFold.setAttribute("aria-expanded", String(!folded));
    store.set("colonne-masquee", folded ? "1" : "");
    if (!folded) map.resize();
    window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
  }

  function setColumnWidth(px) {
    if (px == null) column.style.removeProperty("width");  // largeur par défaut (CSS)
    else column.style.width = `${Math.round(px)}px`;
    map.resize();
    window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
  }

  if (Number(store.get("colonne-largeur"))) setColumnWidth(Number(store.get("colonne-largeur")));
  setColumnFolded(store.get("colonne-masquee") === "1");
  narrow.addEventListener("change", () => setColumnFolded(column.hidden));  // sens des flèches
  columnFold.addEventListener("click", () => setColumnFolded(!column.hidden));
  columnFold.addEventListener("pointerdown", (event) => event.stopPropagation());  // pas de glisser
  columnGrip.addEventListener("dblclick", (event) => {
    if (event.target === columnFold || column.hidden) return;
    store.set("colonne-largeur", "");
    setColumnWidth(null);
  });
  columnGrip.addEventListener("pointerdown", (event) => {
    if (column.hidden || narrow.matches) return;  // largeur réglable seulement colonne affichée, à droite
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

  /** Producteur de la photo (fiche STAC), ou "". */
  function photoProducer(feature) {
    const p = feature.properties || {};
    return ((p.providers || feature.providers || []).find((x) => (x.roles || []).includes("producer")) || {}).name
      || String(p["geovisio:producer"] || "");
  }

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
    const saved = store.get("photo");
    const id = firstUse || !saved ? DEFAULT_PHOTO : saved;  // première utilisation : la photo par défaut
    if (photo) return;  // photo déjà choisie entre-temps
    try {
      const feature = await Carte.photoById(id);
      if (!feature || photo) return;  // photo supprimée depuis, ou autre photo choisie
      if (app && !passesFilter(feature)) return;  // sinon vérifiée au chargement du calcul
      openPhoto(feature);
      map.jumpTo({ center: feature.geometry.coordinates, zoom: 17 });
      if (id === DEFAULT_PHOTO) lookWhenShown(feature, DEFAULT_HEADING);
    } catch (error) {
      console.warn("Dernière photo non rouverte :", error);
    }
  }

  /** Vue tournée vers le cap heading (degrés) dès que la photo est affichée. */
  function lookWhenShown(feature, heading) {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - t0 > 30000 || (photo && photo.id !== feature.id)) {
        clearInterval(timer);  // trop long, ou autre photo choisie entre-temps
        return;
      }
      if (psv?.getPictureMetadata?.()?.id !== feature.id) return;
      clearInterval(timer);
      const azimuth = Number(feature.properties?.["view:azimuth"]) || 0;  // cap du centre de la photo
      const yaw = (((heading - azimuth) % 360 + 540) % 360 - 180) * Math.PI / 180;
      setTimeout(() => psv.rotate({ yaw, pitch: 0 }), 300);  // après la mise en place de la vue
    }, 200);
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
    for (const id of ["#mesure", "#mode", "#camera", "#effacer", "#tout-effacer", "#calage-exporter",
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

  /** Redessine tout : texte de la mesure, état de la photo, repères, carte, résultats. */
  function refresh(text) {
    if (!app) return;
    setStatus(text ?? app.status());
    const rtkAlert = app.take_rtk_alert();  // séquence sans RTK : fenêtre, une fois par séquence
    if (rtkAlert && !$("#alerte-rtk").open) {
      $("#alerte-rtk p").textContent = rtkAlert;
      $("#alerte-rtk").showModal();
    }
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
    pointReady = state.point;
    pointSelected = state.point_sel;
    if (aiming !== state.aiming || newMeasure !== state.new_measure || edgeBAiming !== state.edge_b_aiming) {
      aiming = state.aiming;  // point validé ou à trianguler, largeur faite, bord opposé en visée
      newMeasure = state.new_measure;
      edgeBAiming = state.edge_b_aiming;
      applyMeasureUi();
    }
    edgeBOffered = state.edge_b;
    showModeOptions();  // « Valider le point triangulé » : dès que les visées donnent un point
    showGuide(state.guide);
    // Retour sur la photo de référence : vue cadrée sur A, ou sur la largeur, une fois la photo
    // affichée (avant, son chargement remettrait la vue d'origine)
    if (photoReady()) frameView(JSON.parse(app.take_frame()));
    const bandeau = $("#bandeau");
    bandeau.hidden = !state.waiting_map;
    bandeau.textContent = "Cliquez maintenant ce repère sur la carte (Échap pour annuler).";
    map.getCanvas().style.cursor = state.waiting_map ? "crosshair" : "";
    if (app.calibration_version !== savedCalibration) {
      savedCalibration = app.calibration_version;
      store.set("calage", app.calibration_json());
    }
    drawViewerMarks(JSON.parse(app.viewer_marks()));
    Carte.showMeasures(map, JSON.parse(app.map_geojson()));
    Carte.showHandles(map, JSON.parse(app.handles()), (index, lon, lat) => refresh(app.move_handle(index, lon, lat)));
    frame(app.focus());
    showResults(JSON.parse(app.results()));
    const results = app.has_results();
    $("#csv").disabled = !results;
    $("#geojson").disabled = !results;
  }

  /**
   * Carte cadrée sur la mesure en cours (photo, visées, point de référence, mesure : voir
   * App.focus), seulement quand ces points changent : la carte reste libre entre-temps.
   */
  let framed = "[]";
  function frame(focus) {
    if (focus === framed) return;
    framed = focus;
    const points = JSON.parse(focus);
    // Segment seul (mesure libre) : marge plus large, pour le voir entier avec ses étiquettes
    const segment = points[points.length - 1] === "segment" && points.pop();
    if (points.length < 2 || mapBox.hidden) return;
    const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
    map.fitBounds(bounds, { padding: segment ? 50 : 40, maxZoom: segment ? 22 : 20, duration: 400 });
  }

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
      const remove = Object.assign(document.createElement("button"), {
        type: "button", className: "effacer-resultat", textContent: "×", title: "Effacer ce résultat",
      });
      remove.setAttribute("aria-label", `Effacer : ${r.text}`);
      remove.addEventListener("click", () => {
        refresh(app.delete_result(r.kind, r.id));
        proposeDistance();
      });
      const line = document.createElement("div");
      line.className = "ligne";
      line.append(text, remove);
      li.append(line, comment);
      return li;
    }));
    if (focused) ol.querySelector(`[data-key="${focused}"]`)?.focus();
  }

  /** Point effacé au milieu d'une chaîne (A–B–C) : propose de mesurer la distance A–C. */
  function proposeDistance() {
    const proposal = JSON.parse(app.take_proposal());
    if (!proposal) return;
    const [i, j, a, c] = proposal;
    const dialog = $("#proposer-distance");
    dialog.querySelector("h2 span").textContent = `${a}–${c}`;
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "oui") refresh(app.link_points(i, j));
    }, { once: true });
    dialog.showModal();
  }

  // Choix de la photo sur la carte ---------------------------------------------------------

  map.on("click", async (event) => {
    const { lng, lat } = event.lngLat;
    if (app && app.map_click(lng, lat)) {  // repère du calage du cap
      refresh();
      return;
    }
    openNearest(lng, lat);
  });

  /** Photo la plus proche du point (lng, lat), qui passe le filtre ; avec un cap `heading`
   * (degrés), celle d'un véhicule roulant dans ce sens à 90° près, à défaut la plus proche. */
  async function openNearest(lng, lat, heading = null) {
    showPhotoInfo(null, "Recherche de la photo la plus proche…");
    const sameWay = (feature) => {
      const azimuth = Number(feature.properties?.["view:azimuth"]);
      return Number.isFinite(azimuth) && Math.abs(((azimuth - heading) % 360 + 540) % 360 - 180) < 90;
    };
    try {
      const feature = (heading != null
        ? await Carte.nearestPhoto(map, lng, lat, (f) => passesFilter(f) && sameWay(f)) : null)
        || await Carte.nearestPhoto(map, lng, lat, passesFilter);
      if (!feature) {
        showPhotoInfo(null, !filterActive() ? "Aucune photo près de ce point : cliquez sur le filaire orange."
          : app ? `Aucune photo près de ce point avec le filtre (${app.filter_text()}).`
          : "Filtre en attente du calcul, encore en chargement : cliquez à nouveau dans un instant.");
        return;
      }
      openPhoto(feature);
    } catch (error) {
      showPhotoInfo(null, `Recherche impossible : ${error.message}`);
    }
  }

  function onEscapeKey(event) {
    if (event.key === "Escape" && app && app.waiting_map()) refresh(app.cancel_landmark());
  }
  document.addEventListener("keydown", onEscapeKey);
  // Clic droit dans la visionneuse en mesure : sélection d'un point, pas de menu du navigateur
  viewer.addEventListener("contextmenu", (event) => {
    if (measuring) event.preventDefault();
  });

  // Point sélectionné déplacé de 1 cm par les flèches : largeur, le long de la droite de mesure,
  // dans le sens vu sur la photo (← →) ou en s'éloignant de la caméra (↑ ↓) ; hauteur, monté ou
  // descendu (↑ ↓). Entrée termine son calage.
  let pointSelected = false;
  const NUDGE_KEYS = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down" };
  function onNudgeKey(event) {
    const direction = NUDGE_KEYS[event.key];
    if ((!direction && event.key !== "Enter") || !app || !measuring || !pointSelected) return;
    if (event.target.closest?.("input, select, textarea, button")) return;  // champ ou bouton actif
    event.preventDefault();
    event.stopPropagation();
    refresh(direction ? app.nudge_point(direction) : app.finish_point());  // Entrée : calage terminé
  }
  document.addEventListener("keydown", onNudgeKey, true);

  // Carte détachable dans une fenêtre à part, à placer sur un second écran (Edge, Chrome :
  // fenêtre « image dans l'image » de document ; ailleurs, pas de bouton). La carte y est
  // déplacée telle quelle : elle suit la photo, les mesures et le cadrage sans synchronisation.
  // Fermer la fenêtre, ou le bouton « ⧉ » ou « Remettre la carte ici », la remet en place.

  let mapWindow = null;
  const detachButton = document.createElement("button");

  async function toggleMapWindow() {
    if (mapWindow) {
      mapWindow.close();  // pagehide : carte remise en place
      return;
    }
    if (mapBox.hidden) setFolded(false);
    const place = { parent: mapBox.parentNode, next: mapBox.nextSibling };
    let win;
    try {
      win = await documentPictureInPicture.requestWindow({
        width: Math.max(640, Math.round(mapBox.clientWidth * 1.6)),
        height: Math.max(480, Math.round(mapBox.clientHeight * 1.6)),
      });
    } catch (error) {
      setStatus(`Carte non détachée : ${error.message}`);
      return;
    }
    mapWindow = win;
    // Styles de la page (feuilles d'un autre site, illisibles ici : reprises par leur lien)
    for (const sheet of document.styleSheets) {
      try {
        const style = win.document.createElement("style");
        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
        win.document.head.append(style);
      } catch {
        if (sheet.href) {
          win.document.head.append(Object.assign(win.document.createElement("link"), { rel: "stylesheet", href: sheet.href }));
        }
      }
    }
    win.document.title = "Carte · Mesures Panoramax";
    win.document.body.classList.add("fenetre-carte");
    win.document.body.append(mapBox);
    win.document.addEventListener("keydown", onEscapeKey);
    win.document.addEventListener("keydown", onNudgeKey, true);
    // Glisser la carte : MapLibre suit la souris sur le document qui la contenait à sa création
    // (la page) ; dans la fenêtre détachée, les mouvements arrivent à son document à elle : on
    // les lui transmet (gestionnaire interne de MapLibre, le même que pour la page)
    const handlers = map.handlers;
    if (handlers?.handleWindowEvent) {
      win.document.addEventListener("mousemove", handlers.handleWindowEvent, { capture: true });
      win.document.addEventListener("mouseup", handlers.handleWindowEvent);
    }
    win.addEventListener("resize", () => map.resize());
    win.addEventListener("pagehide", () => {
      place.parent.insertBefore(mapBox, place.next);
      mapWindow = null;
      showDetached(false);
      map.resize();
    });
    showDetached(true);
    map.resize();
  }

  function showDetached(detached) {
    $("#carte-detachee").hidden = !detached;
    grip.hidden = detached;
    detachButton.textContent = "⧉";
    detachButton.title = detached ? "Remettre la carte dans la page"
      : "Détacher la carte dans une fenêtre à part (second écran)";
    detachButton.classList.toggle("actif", detached);
  }

  if ("documentPictureInPicture" in window) {
    detachButton.type = "button";
    detachButton.className = "detacher-carte";
    detachButton.addEventListener("click", toggleMapWindow);
    showDetached(false);
    map.addControl({
      onAdd: () => Object.assign(document.createElement("div"), { className: "maplibregl-ctrl maplibregl-ctrl-group" })
        .appendChild(detachButton).parentNode,
      onRemove: () => {},
    }, "top-left");
    $("#rattacher-carte").addEventListener("click", toggleMapWindow);
  }

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

  /**
   * Ferme la photo affichée, qui n'est plus de l'instance ou ne passe plus le filtre choisis :
   * ses flèches mèneraient sinon aux photos voisines qu'ils écartent. Les résultats restent.
   */
  function closePhoto(message) {
    if (measuring) $("#mesure").click();
    photo = null;
    store.set("photo", "");
    viewer.hidden = true;
    $("#invite").hidden = false;
    $("#producteur-photo").hidden = true;
    $("#capture-hd").disabled = true;
    $("#vignette").disabled = true;
    Carte.showView(map, null);
    showPhotoInfo(null, message);
  }

  /** Photo affichée encore de l'instance et dans le filtre choisis ? Sinon, fermée. */
  async function checkPhoto() {
    const shown = photo;
    if (!shown) return;
    if (!passesFilter(shown)) {
      closePhoto(app ? `Photo fermée : hors du filtre (${app.filter_text()}).` : "Photo fermée : hors du filtre.");
      return;
    }
    try {
      const feature = await Carte.photoById(shown.id);  // cherchée dans l'instance choisie
      if (!feature && photo === shown) closePhoto("Photo fermée : elle n'est pas dans l'instance choisie.");
    } catch (error) {
      console.warn("Instance de la photo non vérifiée :", error);
    }
  }

  function setPhoto(feature, recenter) {
    photo = feature;
    store.set("photo", feature.id);  // rouverte à la prochaine visite (voir reopenPhoto)
    // En bas à droite de la visionneuse : « 2025 – producteur » (année de la prise de vue)
    const producer = photoProducer(feature);
    const taken = (feature.properties?.datetime || "").slice(0, 4);
    $("#producteur-photo").textContent = [taken, producer].filter(Boolean).join(" – ");
    $("#producteur-photo").hidden = !producer && !taken;
    // PCRS : option active seulement là où un PCRS est publié sur la Géoplateforme
    Carte.pcrsAt(map, ...feature.geometry.coordinates).then((zone) => {
      if (photo !== feature) return;
      const option = $("#fond option[value=pcrs]");
      option.disabled = !zone;
      option.title = zone ? `PCRS ${zone.producteur}${zone.date ? `, ${zone.date}` : ""} (zoom 15 et plus)`
        : "Aucun PCRS publié sur la Géoplateforme à cet endroit";
    });
    // Ortho-express de l'année de la photo (ou la plus proche disponible), annoncée dans la liste
    const year = Number((feature.properties?.datetime || "").slice(0, 4));
    if (year) {
      Carte.setExpressYear(map, year, ...feature.geometry.coordinates).then((used) => {
        if (photo !== feature) return;  // photo déjà quittée
        $("#fond option[value=express]").textContent = used == null ? "Ortho-express (aucune ici)"
          : `Ortho-express ${used}` + (used === year ? "" : ` (photo de ${year})`);
      });
    }
    showPlace(feature);
    const coords = feature.geometry.coordinates;
    Carte.showView(map, coords, viewHeading(), viewFov());
    if (recenter && $("#centrer").checked) map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 17) });
    showPhotoInfo(feature);
    $("#capture-hd").disabled = !Calcul.hasWorker();
    $("#vignette").disabled = false;
    if (app) refresh(app.set_picture(JSON.stringify(feature)));
    updateProducers();
    checkFarFromMeasures(coords);
  }

  // Photo loin des mesures : proposer de repartir de zéro ------------------------------------

  const FAR_FROM_MEASURES = 100;  // m
  let farAsked = false;  // déjà proposé pour cet éloignement : redemandé après un retour près des mesures

  /** Distance (m) de la photo en lonlat à la mesure la plus proche (points triangulés, cibles des
   * visées, points et traits des mesures), ou null sans mesure. Les traits de visée partent des
   * photos, la droite de mesure et le calage ne comptent pas. */
  function distanceToMeasures(lonlat) {
    if (!app) return null;
    const kinds = new Set(["mesure", "point", "etiquette", "triangule", "cible", "distance"]);
    const k = Math.cos(lonlat[1] * Math.PI / 180) * 111320;
    let best = null;
    for (const f of JSON.parse(app.map_geojson()).features) {
      if (!kinds.has(f.properties.kind)) continue;
      const coords = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const [lon, lat] of coords) {
        const d = Math.hypot((lon - lonlat[0]) * k, (lat - lonlat[1]) * 111320);
        if (best == null || d < best) best = d;
      }
    }
    return best;
  }

  function checkFarFromMeasures(lonlat) {
    const d = distanceToMeasures(lonlat);
    if (d == null || d <= FAR_FROM_MEASURES) {
      farAsked = false;
      return;
    }
    const dialog = $("#loin-mesures");
    if (farAsked || dialog.open) return;
    farAsked = true;
    stopPlayer();  // lecture de la séquence arrêtée le temps de répondre
    dialog.querySelector("p span").textContent = d >= 1000 ? `${(d / 1000).toFixed(1).replace(".", ",")} km`
      : `${Math.round(d)} m`;
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "oui") refresh(app.clear_all());
    }, { once: true });
    dialog.showModal();
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
      ["Producteur", photoProducer(feature)],
      ["Caméra", (p["pers:interior_orientation"] || {}).camera_model || ""],
      ["Précision GPS", accuracy != null ? `${String(accuracy).replace(".", ",")} m` : ""],
      ["Identifiant", feature.id],
    ];
    const dl = document.createElement("dl");
    for (const [label, value] of rows) {
      dl.append(Object.assign(document.createElement("dt"), { textContent: label }),
        Object.assign(document.createElement("dd"), { textContent: value || "—" }));
    }
    // Identifiant à copier d'un clic : pour retrouver la photo (tests entre collègues)
    const copy = Object.assign(document.createElement("button"), { type: "button", className: "copier",
      textContent: "📋 Copier", title: "Copier l'identifiant de la photo dans le presse-papiers" });
    copy.addEventListener("click", () => copyText(feature.id, copy));
    dl.lastElementChild.append(copy);
    section.replaceChildren(dl);
  }

  // Aller à une photo par son identifiant (ou un lien Panoramax qui le contient)
  $("#aller-photo").addEventListener("submit", async (event) => {
    event.preventDefault();
    const help = $("#aller-photo .aide");
    const match = $("#id-photo").value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    help.hidden = false;
    if (!match) {
      help.textContent = "Identifiant non reconnu : collez l'identifiant de la photo (8-4-4-4-12 caractères).";
      return;
    }
    help.textContent = "Recherche de la photo…";
    try {
      const feature = await Carte.photoById(match[0].toLowerCase());
      if (!feature) {
        help.textContent = "Photo introuvable sur l'instance choisie (Réglages › Instance).";
        return;
      }
      help.hidden = true;
      $("#id-photo").value = "";
      openPhoto(feature);
      map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
    } catch (error) {
      help.textContent = `Recherche impossible : ${error.message}`;
    }
  });
  // Les touches de la boîte ne vont ni à la carte ni aux recalages au clavier
  $("#id-photo").addEventListener("keydown", (event) => event.stopPropagation());

  /** Copie text dans le presse-papiers ; le bouton affiche « ✔ Copié » un instant. Repli sur
   * une sélection copiée quand le navigateur refuse l'accès au presse-papiers (page en file://). */
  async function copyText(text, button) {
    let done = false;
    try {
      await navigator.clipboard.writeText(text);
      done = true;
    } catch {
      const area = Object.assign(document.createElement("textarea"), { value: text });
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      try { done = document.execCommand("copy"); } catch { done = false; }
      area.remove();
    }
    const label = button.textContent;
    button.textContent = done ? "✔ Copié" : "Copie refusée";
    setTimeout(() => { button.textContent = label; }, 1500);
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

  let guideHeading = null;
  function updateCursor() {
    if (photo) Carte.showView(map, photo.geometry.coordinates, viewHeading(), viewFov());
    // Flèches des photos proposées : refaites quand la vue a tourné de plus de 5°
    const heading = viewHeading();
    if (guideShown && heading != null && (guideHeading == null || Math.abs(((heading - guideHeading) % 360 + 540) % 360 - 180) > 5)) {
      guideHeading = heading;
      showGuide(guideShown);
    }
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
        if (event?.type === "click" && measuring && !onArrow(event)) {
          if (app && event.data?.rightclick) {  // clic droit : sélection d'un point à recaler
            refresh(photoReady() ? app.select_point(event.data.yaw, event.data.pitch) : LOADING);
          } else if (app) {
            refresh(photoReady() ? app.click(event.data.yaw, event.data.pitch) : LOADING);
          }
          return true;
        }
        return dispatch.call(this, event);
      };
      attachPlayer();
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
          const feature = await Carte.photoById(id);  // null : photo d'une autre instance
          if (feature && passesFilter(feature)) {
            setPhoto(feature, true);
          } else if (photo) {  // photo voisine écartée : retour à la précédente
            stopPlayer();  // la lecture y reviendrait sans fin
            viewer.select(photo.collection || null, photo.id, true);
            notice(feature ? `Photo voisine hors du filtre (${app ? app.filter_text() : "calcul en chargement"}).`
              : "Photo voisine hors de l'instance choisie.");
          }
        } catch (error) {
          console.error(error);
        }
      });
      applyMeasureUi();
      refresh();
      updateCursor();
    }, 200);
  }

  // Lecture de la séquence --------------------------------------------------------------------

  // Lecture en arrière, pause et reprise (même sens, même vitesse), lecture en avant. Chaque
  // appui sur un sens déjà en lecture passe à la vitesse suivante : 1x → 2x → 4x → 8x → 16x → 1x.
  // 1x : lecteur de la visionneuse officielle (playSequence, stopSequence). 2x à 16x : une photo
  // sur 2, 4, 8 ou 16, les autres jamais chargées ; leur liste vient de l'instance de la photo, par
  // rangs dans la séquence (le méta-catalogue ignore startAfterRank). Hors de la prise de
  // mesure : on y change de photo par la carte.
  const SPEEDS = [1, 2, 4, 8, 16];
  const WINDOW = 100;  // photos de la séquence lues d'un coup (environ 5 Ko chacune)
  let backward = false;  // sens de la dernière lecture, repris par « pause/reprise »
  let speed = 1;  // vitesse de la dernière lecture, reprise de même
  let fast = null;  // lecture rapide (2x à 16x) en cours : { collection, origin, rank, step, id, ids, timer }

  function playing() {
    return Boolean(fast) || Boolean(psv?.isSequencePlaying?.());
  }

  function stopPlayer() {
    if (fast) {
      clearTimeout(fast.timer);
      fast = null;
      updatePlayer();
    }
    if (psv?.isSequencePlaying?.()) psv.stopSequence();
  }

  /** Adresse de l'instance qui sert la photo (celle de ses images), ou "". */
  function instanceOrigin(feature) {
    const href = feature?.assets?.sd?.href || feature?.assets?.hd?.href || "";
    try {
      return new URL(href).origin;
    } catch {
      return "";
    }
  }

  function play(back, k) {
    stopPlayer();
    backward = back;
    speed = k;
    const rank = Number(photo?.properties?.["geovisio:rank_in_collection"]);
    const origin = instanceOrigin(photo);
    if (k === 1 || !Number.isInteger(rank) || !origin || !photo.collection) {
      if (k !== 1) console.warn("Lecture rapide impossible (rang ou instance de la photo inconnus) : 1x");
      speed = 1;
      psv.playSequence(back);
      return;
    }
    fast = { collection: photo.collection, origin, rank, step: back ? -k : k, id: photo.id, ids: new Map(), timer: null };
    updatePlayer();
    fastStep(fast);
  }

  /** Photos de la séquence autour du rang r, dans le sens de la lecture : rang -> identifiant. */
  async function loadRanks(run, r) {
    const start = run.step > 0 ? r - 1 : Math.max(0, r - WINDOW);
    const url = `${run.origin}/api/collections/${encodeURIComponent(run.collection)}/items?limit=${WINDOW}&startAfterRank=${start}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for (const f of (await response.json()).features || []) {
      const rank = Number(f.properties?.["geovisio:rank_in_collection"]);
      if (Number.isInteger(rank) && f.id) run.ids.set(rank, f.id);
    }
  }

  /** Photo suivante de la lecture rapide : k rangs plus loin, ou la dernière de la séquence. */
  async function fastStep(run) {
    const sign = Math.sign(run.step);
    let target = run.rank + run.step;
    try {
      if (!run.ids.has(target)) await loadRanks(run, target);
    } catch (error) {
      console.warn("Lecture rapide :", error);
    }
    if (run !== fast) return;  // arrêtée entre-temps
    while (target !== run.rank && !run.ids.has(target)) target -= sign;  // fin de la séquence
    if (target === run.rank) {
      stopPlayer();
      return;
    }
    run.rank = target;
    run.id = run.ids.get(target);
    viewer.select(run.collection, run.id, true);
  }

  function updatePlayer() {
    const seq = psv?.getPictureMetadata?.()?.sequence || {};
    const on = playing();
    const blocked = measuring || !photo;
    $("#lecture-arriere").disabled = blocked || !seq.prevPic;
    $("#lecture-avant").disabled = blocked || !seq.nextPic;
    $("#lecture-pause").disabled = blocked || !(on || (backward ? seq.prevPic : seq.nextPic));
    $("#lecture-arriere").setAttribute("aria-pressed", String(on && backward));
    $("#lecture-avant").setAttribute("aria-pressed", String(on && !backward));
    $("#lecture-pause").classList.toggle("en-lecture", on);
    $("#lecture-pause").title = on ? "Pause"
      : `Reprendre la lecture (${backward ? "en arrière" : "en avant"}, ${speed}x)`;
    // Vitesse à côté du bouton du sens en cours ; estompée à l'arrêt (celle de la reprise)
    for (const [id, back] of [["#vitesse-arriere", true], ["#vitesse-avant", false]]) {
      const label = $(id);
      label.hidden = blocked || backward !== back || (!on && speed === 1);
      label.textContent = `${speed}x`;
      label.classList.toggle("arret", !on);
    }
  }

  function attachPlayer() {
    $("#lecteur").hidden = false;
    const direction = (back) => {
      const same = playing() && backward === back;
      play(back, same ? SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] : 1);
    };
    $("#lecture-arriere").addEventListener("click", () => direction(true));
    $("#lecture-avant").addEventListener("click", () => direction(false));
    $("#lecture-pause").addEventListener("click", () => {
      if (playing()) stopPlayer();
      else play(backward, speed);
    });
    psv.addEventListener("sequence-playing", (event) => {
      backward = Boolean(event.detail?.backward);
      updatePlayer();
    });
    psv.addEventListener("sequence-stopped", updatePlayer);
    psv.addEventListener("picture-loaded", (event) => {
      // Lecture rapide : photo demandée affichée, la suivante après la durée de transition de
      // la visionneuse (comme sa lecture 1x)
      if (fast && event.detail?.picId === fast.id) {
        const run = fast;
        run.timer = setTimeout(() => fastStep(run), psv.getTransitionDuration?.() ?? 250);
      }
      updatePlayer();
    });
    psv.addEventListener("click", () => { if (fast) stopPlayer(); });  // comme la lecture 1x
    updatePlayer();
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

  /**
   * Clics dans la photo pour viser (triangulation, point de référence d'une hauteur) : plusieurs
   * photos, flèches gardées. Suit l'état du calcul (voir refresh).
   */
  let aiming = false;
  let pointReady = false;  // visées qui donnent un point (bouton « Valider le point triangulé »)
  let newMeasure = null;  // largeur faite : nom du point de référence (bouton « Nouvelle mesure depuis A »)
  let edgeBOffered = null;  // largeur faite d'un clic : nom (provisoire) de son bord, à trianguler
  let edgeBAiming = false;  // bord opposé de la largeur en cours de triangulation

  /**
   * Flèches masquées en mesure (elles gênent les clics de mesure), sauf pour viser, ce qui
   * demande de changer de photo. Pendant la prise de mesure, on change de photo par la carte.
   */
  function hidesArrows() {
    return measuring && !aiming;
  }

  /** Clic sur une flèche de la visionneuse (photo suivante, précédente…) : il navigue. */
  function onArrow(event) {
    const target = event.data?.target;
    return Boolean(target?.closest?.(".psv-virtual-tour-link"));
  }

  // Pointeur de mesure : réticule fin (comme le plugin), la visionneuse imposant sinon main ou flèche
  // Cercle extérieur jaune, vert une fois l'inclinaison de la photo calée (voir showLights), orange en calage,
  // bleu pendant les visées de triangulation
  // En calage, cercle orange ; pendant les visées de triangulation, bleu : comme le liseré de la
  // visionneuse (et les croix des visées)
  const CALAGE = "#ff6f00", VISEE = "#00bce6";
  const cursorCss = (tilted, calibrating, sighting) => `.psv-container, .psv-container * { cursor: url("data:image/svg+xml;utf8,${
    encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='33' height='33'>"
      + `<circle cx='16.5' cy='16.5' r='15' fill='none' stroke='${
        calibrating ? CALAGE : sighting ? VISEE : tilted ? "#2ecc40" : "#ffeb00"}' stroke-width='2.5'/>`
      + "<path d='M16.5 2v11M16.5 20v11M2 16.5h11M20 16.5h11' stroke='#ff8a80' stroke-width='1.5'/>"
      + "<circle cx='16.5' cy='16.5' r='1' fill='white'/></svg>")}") 16 16, crosshair !important; }
    .psv-container .psv-virtual-tour-link, .psv-container .psv-virtual-tour-link * { cursor: pointer !important; }`;
  let tilted = false;  // inclinaison de la photo affichée calée

  /** Navigation, flèches, curseur au sol et pointeur de la visionneuse selon le bouton « Mesure ». */
  function applyMeasureUi() {
    $("#mesure").setAttribute("aria-pressed", String(measuring));
    $("#mesure").classList.toggle("actif", measuring);
    $("#mode-mesure").hidden = !measuring;
    const mode = $("#mode").value;
    // Liseré autour de la visionneuse : bleu pendant les visées de triangulation, jaune pendant la
    // prise de mesure (couleurs de leurs croix)
    const sighting = measuring && aiming;
    const taking = measuring && !aiming && ["road", "height"].includes(mode);
    const calibrating = measuring && ["tilt", "heading"].includes(mode);
    $("#vue").classList.toggle("visee", sighting);
    $("#vue").classList.toggle("prise", taking);
    $("#vue").classList.toggle("calage", calibrating);
    // Largeur, mesure libre : trait vertical au centre de la vue, le cap tracé sur la carte
    $("#axe-vue").hidden = !measuring || !["road", "tri"].includes(mode) || viewer.hidden;
    // Même état en toutes lettres, sous le rappel du mode (comme les voyants)
    const state = $("#etat-mesure");
    state.hidden = !sighting && !taking;
    state.className = sighting ? "visee" : taking ? "prise" : "";
    state.textContent = sighting ? "Triangulation en cours" : taking ? "Mesure en cours" : "";
    $("#mode-mesure").textContent = mode === "tri"
      ? "Mesure libre : visez chaque point depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "height" && aiming ? "Hauteur, étape 1 : visez le pied depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "height" && newMeasure ? `Hauteur faite : cliquez une de ses croix pour l'ajuster ; autre hauteur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "height" ? "Hauteur, étape 2 : cliquez le sommet (le pied est le point visé) ; autre photo : par la carte"
      : mode === "road" && edgeBAiming ? "Largeur, bord opposé : le clic de la mesure est la 1re visée ; photo suivante, même bord, puis « Valider le point triangulé »"
      : mode === "road" && aiming ? "Largeur, étape 1 : visez le premier bord depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "road" && newMeasure ? `Largeur faite : cliquez une de ses croix pour l'ajuster ; autre largeur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "road" ? "Largeur, étape 2 : cliquez le bord opposé ; autre photo, prise avant ou après : par la carte"
      : mode === "tilt" ? "Calage de l'inclinaison : pied puis sommet de deux objets verticaux, à 90° l'un de l'autre"
      : mode === "heading" ? "Calage du cap : un repère dans la photo, puis le même sur la carte (3 pour la position)"
      : "Mode mesure en cours : désélectionner pour naviguer";
    showModeOptions();
    const box = psv?.container;
    if (!box) return;
    for (const arrows of box.querySelectorAll(".psv-virtual-tour-arrows")) {
      if (hidesArrows()) arrows.style.setProperty("visibility", "hidden", "important");
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
    if (measuring && !style) {
      style = Object.assign(document.createElement("style"), { id: "mesure-pointeur" });
      (root === document ? document.head : root).append(style);
    } else if (!measuring && style) {
      style.remove();
    }
    if (style?.isConnected) {
      const css = cursorCss(tilted, calibrating, sighting);
      if (style.textContent !== css) style.textContent = css;
    }
  }

  $("#mesure").addEventListener("click", () => {
    measuring = !measuring;
    if (measuring) stopPlayer();  // la mesure se fait sur une photo arrêtée
    applyMeasureUi();
    if (psv) updatePlayer();
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
    const names = namesOf(marks);
    marks.forEach((mark, m) => {
      const points = mark.points.map(([yaw, pitch]) => ({ yaw, pitch }));
      if (mark.guide) {  // tirets sans croix : droite de mesure (largeur, bleue), verticale (hauteur, verte)
        if (points.length >= 2) {
          add({
            id: `${MARK}${m}-${mark.epipolar ? "epipolaire" : "guide"}`, polyline: points.map(({ yaw, pitch }) => [yaw, pitch]),
            // Visée d'une autre photo (ligne épipolaire) : pointillés fins ; droite de mesure et
            // verticale : tirets
            svgStyle: mark.epipolar ? { stroke: "#00bce6", strokeWidth: "2.5px", strokeDasharray: "5 4", fill: "none" }
              : { stroke: mark.vertical ? "#2ecc40" : "#00bce6", strokeWidth: "2px", strokeDasharray: "8 5", fill: "none" },
          });
        }
        return;
      }
      if (mark.name) {  // nom d'un point triangulé : étiquette seule, du côté opposé à la mesure ;
        // grise pour le bord cliqué d'une largeur, pas encore triangulé (nom provisoire)
        add({
          id: `${MARK}${m}-nom`, position: points[0], anchor: "center center",
          html: `<div class="ancre"><div class="etiquette nom ${mark.side || "below"}${mark.provisional ? " provisoire" : ""}">${
            escapeHtml(mark.label)}</div></div>`,
        });
        return;
      }
      if (points.length >= 2) {
        add({
          id: `${MARK}${m}-trait`, polyline: points.map(({ yaw, pitch }) => [yaw, pitch]),
          svgStyle: { stroke: "#e53935", strokeWidth: "3px", fill: "none" },
        });
      }
      mark.points.forEach(([yaw, pitch, sel], i) => {
        add({
          id: `${MARK}${m}-${i}`, position: { yaw, pitch }, anchor: "center center",
          html: `<div class="croix${sel ? " choisie" : ""}${mark.sighting ? " visee" : ""}"></div>`,
        });
      });
      if (mark.label) {  // au milieu du trait, un peu au-dessus (à côté pour une hauteur)
        // Repère de taille nulle au milieu du trait, étiquette décalée d'un nombre fixe de pixels
        // par le CSS : la visionneuse mesure la taille d'un repère une seule fois, parfois avant
        // sa mise en page, et l'ancrerait alors trop loin
        add({
          id: `${MARK}${m}-etiquette`, position: middle(points), anchor: "center center",
          html: `<div class="ancre"><div class="etiquette mesure ${mark.beside ? "cote" : "dessus"}">${
            escapeHtml(measureLabel(mark, names))}</div></div>`,
        });
      }
    });
    markers.renderMarkers?.();
  }

  /** Noms des points triangulés (A, B…) de la photo, à leur croix : [[cap, élévation, nom]]. */
  function namesOf(marks) {
    return marks.filter((mark) => mark.name && mark.points.length).map((mark) => [...mark.points[0].slice(0, 2), mark.label]);
  }

  /**
   * Étiquette d'une mesure dans la photo, comme celle d'une mesure libre sur la carte : noms des
   * points aux extrémités du trait, dans l'ordre alphabétique, de part et d'autre du symbole
   * (« B↔C 4,84 m ± 0,33 m »). Un point est nommé quand une croix nommée est à moins de 0,1°.
   */
  function measureLabel(mark, names) {
    const ends = [mark.points[0], mark.points[mark.points.length - 1]];
    const found = [...new Set(ends.flatMap(([yaw, pitch]) => names
      .filter(([y, p]) => Math.hypot(Math.atan2(Math.sin(y - yaw), Math.cos(y - yaw)) * Math.cos(pitch), p - pitch) < 0.0018)
      .map(([, , name]) => name)))].sort((a, b) => a.localeCompare(b, "fr"));
    const match = /^([↔↕]) (.*)$/.exec(mark.label);
    if (!found.length || !match) return mark.label;
    const [, symbol, value] = match;
    return found.length === 1 ? `${found[0]}${symbol} ${value}` : `${found.join(symbol)} ${value}`;
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

  // Visées guidées (hauteur, largeur) : photos proposées par le calcul ----------------------

  let guideShown = null;  // dernières photos proposées : flèches refaites quand la vue tourne

  /**
   * Flèche d'une photo proposée, selon où elle se trouve par rapport au centre de la vue : ◀ ▶
   * sur le côté, ▲ devant, ▼ derrière (la précédente n'est pas toujours à gauche : en regardant
   * devant à droite, elle est derrière, légèrement à droite). "" si sa position est inconnue.
   */
  function guideArrow(choice) {
    const view = viewHeading();
    if (view == null || choice.lon == null || !photo) return "";
    const [lon0, lat0] = photo.geometry.coordinates;
    const x = (choice.lon - lon0) * Math.cos(lat0 * Math.PI / 180), y = choice.lat - lat0;
    const bearing = Math.atan2(x, y) * 180 / Math.PI;
    const off = ((bearing - view) % 360 + 540) % 360 - 180;  // -180 à 180 : gauche < 0 < droite
    if (Math.abs(off) < 30) return "▲";
    if (Math.abs(off) > 150) return "▼";
    return off < 0 ? "◀" : "▶";
  }

  function showGuide(guide) {
    guideShown = guide;
    const box = $("#guide-photos");
    const choices = (measuring && guide && guide.choices) || [];
    box.hidden = !choices.length || viewer.hidden;
    box.replaceChildren(...choices.map((choice) => {
      const arrow = guideArrow(choice);
      const button = Object.assign(document.createElement("button"), { type: "button",
        textContent: arrow === "◀" ? `◀ ${choice.label}` : arrow ? `${choice.label} ${arrow}` : choice.label,
        title: choice.title });
      button.addEventListener("click", () => goToPhoto(choice.id));
      return button;
    }).sort((a, b) => a.textContent.startsWith("◀") ? -1 : b.textContent.startsWith("◀") ? 1 : 0));  // ◀ à gauche
  }

  /**
   * Vue cadrée sur des points de la photo ([[cap, élévation]] en radians, repère de la photo) :
   * centrée sur eux, zoom ajusté pour les voir tous (le point A seul, ou la largeur de A à B).
   */
  function frameView(points) {
    if (!psv || !points || !points.length) return;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const yaw = Math.atan2(points.reduce((t, p) => t + Math.sin(p[0]), 0), points.reduce((t, p) => t + Math.cos(p[0]), 0));
    const pitches = points.map((p) => p[1]);
    const pitch = (Math.min(...pitches) + Math.max(...pitches)) / 2;
    const spreadYaw = 2 * Math.max(...points.map((p) => Math.abs(wrap(p[0] - yaw))));
    const spreadPitch = Math.max(...pitches) - Math.min(...pitches);
    const box = psv.container, aspect = box.clientWidth / Math.max(box.clientHeight, 1);
    // Champ vertical : la largeur avec une marge (au plus le champ maximal de la visionneuse :
    // une largeur vue de très près peut ne pas tenir entière), ou 35° pour un point seul
    const deg = (r) => r * 180 / Math.PI;
    const maxFov = psv.config?.maxFov || 90;
    const vfov = Math.min(maxFov, Math.max(points.length > 1 ? 20 : 35, deg(spreadPitch) * 1.3, deg(spreadYaw) * 1.3 / aspect));
    const zoom = psv.dataHelper?.fovToZoomLevel ? psv.dataHelper.fovToZoomLevel(vfov) : undefined;
    psv.animate({ yaw, pitch, ...(zoom == null ? {} : { zoom }), speed: 1200 });
  }

  /** Affiche la photo d'identifiant id (photo voisine proposée, retour sur la référence). */
  async function goToPhoto(id) {
    try {
      const feature = await Carte.photoById(id);
      if (feature) openPhoto(feature);
      else notice("Photo introuvable sur l'instance choisie.");
    } catch (error) {
      console.warn("Changement de photo :", error);
    }
  }

  // Mode et réglages de la mesure ----------------------------------------------------------

  function showModeOptions() {
    const mode = $("#mode").value;
    for (const option of document.querySelectorAll("header .option")) {
      const modes = option.dataset.modes.split(" ");
      // « Nouveau point de référence » : une fois le point validé
      option.hidden = !modes.includes(mode) || (option.contains($("#nouvelle-reference")) && aiming);
    }
    // « Valider le point triangulé », dans la visionneuse : dès que les visées donnent un point
    $("#garder").hidden = !measuring || !aiming || !pointReady || viewer.hidden;
    $("#nouvelle-mesure").hidden = !measuring || !newMeasure || viewer.hidden;
    $("#trianguler-b").hidden = !measuring || !edgeBOffered || viewer.hidden;
    if (edgeBOffered) $("#trianguler-b").textContent = `🎯 Trianguler le point ${edgeBOffered} (plus précis)`;
    $("#nouvelle-mesure").textContent = `↺ Nouvelle mesure depuis ${newMeasure || "A"}`;
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
  $("#garder").addEventListener("click", () => {
    refresh(app.keep_point());
    const reference = app.take_goto();  // retour sur la photo de référence, pour la mesure
    if (reference) goToPhoto(reference);
  });
  $("#nouvelle-mesure").addEventListener("click", () => refresh(app.new_measure()));
  $("#trianguler-b").addEventListener("click", () => refresh(app.start_edge_b()));
  $("#nouvelle-reference").addEventListener("click", () => refresh(app.new_reference()));
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

  function filterActive() {
    return Object.values(currentFilter()).some((v) => v != null);
  }

  /** La photo (fiche STAC) passe-t-elle le filtre ? Tant que le calcul se charge, un filtre actif refuse tout. */
  function passesFilter(feature) {
    return app ? app.filter_matches(JSON.stringify(feature)) : !filterActive();
  }

  function applyFilter(save = true) {
    const f = currentFilter();
    if (save) store.set("filtre", JSON.stringify(f));
    Carte.setFilter(map, f);
    if (app) app.set_filter(JSON.stringify(f));
    const active = filterActive();
    $("#filtre-actif").textContent = active ? "●" : "";
    $("#filtre-actif").title = active && app ? app.filter_text() : "";
    if (app) checkPhoto();  // sans le calcul, le filtre n'est pas encore évalué
  }

  /** Message passager en haut de la visionneuse. */
  let noticeTimer = null;
  function notice(text) {
    const box = $("#avis");
    box.textContent = text;
    box.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { box.hidden = true; }, 4000);
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
    const saved = JSON.parse(store.get("filtre", JSON.stringify({ producer: DEFAULT_PRODUCER }))) || {};
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
      await robotoReady();
      drawCartouches(ctx, canvas, Math.max(14, Math.round(canvas.height / 54)), params.caption, placeText());
      download(await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92)), `${params.name}.jpg`);
    } catch (error) {
      setStatus(`Capture « Image seule » impossible : ${error.message}`, "echec");
    } finally {
      button.disabled = !photo || !Calcul.hasWorker();  // photo fermée pendant la capture : reste inactif
      button.textContent = "📷 Image seule";
    }
  });

  $("#vignette").addEventListener("click", async () => {
    if (!psv) return;
    try {
      await robotoReady();
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
    // Comme dans la visionneuse : guides d'abord (dessous), en tirets et sans croix ; mesures en
    // trait rouge ; croix jaunes, bleues pour les visées
    const guidesFirst = [...currentMarks].sort((a, b) => Number(!!b.guide) - Number(!!a.guide));
    const captureNames = namesOf(currentMarks);
    for (const mark of guidesFirst) {
      const pts = mark.points.map(screen);
      if (mark.guide) {
        ctx.save();
        ctx.strokeStyle = mark.vertical ? "#2ecc40" : "#00bce6";
        ctx.lineWidth = (mark.epipolar ? 2.5 : 2) * scale;
        ctx.setLineDash(mark.epipolar ? [5 * scale, 4 * scale] : [8 * scale, 5 * scale]);
        ctx.beginPath();
        let open = false;
        for (const p of pts) {
          if (!p) {
            open = false;
            continue;
          }
          if (open) ctx.lineTo(...p);
          else ctx.moveTo(...p);
          open = true;
        }
        ctx.stroke();
        ctx.restore();
        continue;
      }
      if (mark.name) {  // nom d'un point triangulé, comme dans la visionneuse
        if (pts[0]) {
          const [x, y] = pts[0], g = 10 * scale, h = 15 * scale;  // écart à la croix, taille du texte
          const [lx, ly, align] = { left: [x - g, y + 0.6 * h, "right"], right: [x + g, y + 0.6 * h, "left"],
            above: [x, y - g, "center"] }[mark.side] || [x, y + g + 1.4 * h, "center"];
          label(ctx, mark.label, lx, ly, h, align, mark.provisional ? "rgba(95, 99, 104, 0.92)" : "rgba(142, 27, 27, 0.92)");
        }
        continue;
      }
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
        for (const [color, width] of [["rgba(0,0,0,0.7)", 4], [mark.sighting ? "#00bce6" : "#ffeb00", 2]]) {
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
      const text = measureLabel(mark, captureNames), blue = "rgba(21, 76, 121, 0.92)";  // comme .etiquette.mesure
      if (mid && mark.beside) label(ctx, text, mid[0] + 9 * scale, mid[1] + 9 * scale, 15 * scale, "left", blue);
      else if (mid) label(ctx, text, mid[0], mid[1] - 7 * scale, 15 * scale, "center", blue);
    }
    const caption = app ? app.caption(psv.getPosition().yaw) : "Panoramax";
    drawCartouches(ctx, canvas, 13 * scale, caption, placeText());  // taille de l'étiquette de la visionneuse
    return canvas;
  }

  /** Cartouches d'une capture : attribution en bas à droite, localisation en bas à gauche,
   * ou au-dessus de l'attribution si elles ne tiennent pas côte à côte. */
  function drawCartouches(ctx, canvas, size, caption, place) {
    const margin = size * 0.7;
    const bottom = canvas.height - margin;
    const width = (text, s) => {
      ctx.font = `500 ${s}px Roboto, system-ui, sans-serif`;
      return text ? ctx.measureText(text).width + 1.08 * s : 0;
    };
    // Texte plus large que l'image (vue étroite) : réduit pour tenir dans la largeur
    const fit = (text) => Math.min(size, size * (canvas.width - 2 * margin) / Math.max(width(text, size), 1));
    const captionSize = fit(caption), placeSize = fit(place);
    if (caption) cartouche(ctx, caption, canvas.width - margin, bottom, captionSize, "right");
    if (!place) return;
    const side = width(place, placeSize) + width(caption, captionSize) + 3 * margin <= canvas.width;
    cartouche(ctx, place, margin, side ? bottom : bottom - captionSize * 1.72 - margin / 2, placeSize, "left");
  }

  /** Police Roboto chargée, pour le texte dessiné dans les captures (sinon police de repli). */
  function robotoReady() {
    return document.fonts ? document.fonts.load("500 12px Roboto").catch(() => {}) : Promise.resolve();
  }

  /** Localisation affichée dans la visionneuse (route, PR, commune), ou "". */
  function placeText() {
    return $("#lieu").hidden ? "" : $("#lieu").textContent;
  }

  /** Étiquette d'une capture, dans le style de l'étiquette de localisation de la visionneuse
   * (#lieu : fond sombre semi-transparent, angles arrondis, texte blanc Roboto moyen détouré),
   * ses dimensions rapportées à la taille du texte (13 px dans la visionneuse). (x, y) : bas
   * de l'étiquette, à gauche, à droite ou au centre selon align. */
  function cartouche(ctx, text, x, y, size, align) {
    ctx.font = `500 ${size}px Roboto, system-ui, sans-serif`;
    const padX = size * 0.54, height = size * 1.72;
    const w = ctx.measureText(text).width + 2 * padX;
    const left = align === "right" ? x - w : align === "left" ? x : x - w / 2;
    ctx.save();
    ctx.fillStyle = "rgba(32, 33, 36, 0.55)";
    ctx.beginPath();
    ctx.roundRect(left, y - height, w, height, size * 0.31);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    // Détourage : halo flou, puis ombre décalée (text-shadow de la visionneuse)
    for (const [color, blur, dx, dy] of [["rgba(0, 0, 0, 0.9)", 2, 0, 0], ["rgba(0, 0, 0, 0.6)", 1, 1, 1]]) {
      const k = size / 13;
      Object.assign(ctx, { shadowColor: color, shadowBlur: blur * k, shadowOffsetX: dx * k, shadowOffsetY: dy * k });
      ctx.fillText(text, left + padX, y - height / 2);
    }
    ctx.restore();
  }

  /** Étiquette d'une mesure dans une capture, comme dans la visionneuse (.etiquette). */
  function label(ctx, text, x, y, size, align, background = "rgba(32, 33, 36, 0.85)") {
    ctx.font = `${size}px Roboto, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + size;
    const left = align === "right" ? x - w : align === "left" ? x : x - w / 2;
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.roundRect(left, y - size * 1.4, w, size * 1.6, size * 0.25);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + size / 2, y - size * 0.6);
  }

  // Pour les essais depuis la console : window.mesures.app.click(yaw, pitch)
  window.mesures = { get app() { return app; }, get psv() { return psv; }, map, openPhoto };
})();
