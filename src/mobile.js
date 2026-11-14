// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
// Version mobile (mobile.html) : consultation seule. Photo en haut, carte en bas, recherche de lieux et requêteur route +
// PR au-dessus ; cadastre et parcelle visée, capture de la vue. Sans le calcul (Pyodide) : ni mesures, ni profils.
(() => {
  const $ = (selector) => document.querySelector(selector);
  const store = {
    get(key, fallback = null) {
      try { return localStorage.getItem(`web-measures/${key}`) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`web-measures/${key}`, value); } catch { /* sans stockage */ }
    },
  };
  let messageTimer = null;
  function say(text) {
    clearTimeout(messageTimer);
    $("#message").textContent = text;
    $("#message").hidden = !text;
    if (text) messageTimer = setTimeout(() => { $("#message").hidden = true; }, 4000);
  }

  const viewer = $("#visionneuse");
  const map = Carte.createMap("carte", { textScale: 2 });  // texte du Plan IGN et d'OSM lisible au doigt
  Recherche.attach(map);
  Requeteur.attach(map, (lng, lat, heading, radius) => openNearest(lng, lat, heading, radius));
  $("#barre").append(map.getContainer().querySelector(".recherche"), map.getContainer().querySelector(".requeteur"));
  Carte.showMilestones(map);
  Carte.showAdmin(map);
  map.on("load", () => {
    Carte.setBackground(map, $("#fond").value);
    Carte.setNetworkVisible(map, $("#filaire").checked);
  });
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "bottom-right");

  let photo = null;  // fiche STAC de la photo affichée
  let psv = null;  // visionneuse sphérique (Photo Sphere Viewer)

  // Photo -----------------------------------------------------------------------------------

  async function openNearest(lng, lat, heading = null, radius = null) {
    const sameWay = (f) => {
      const azimuth = Number(f.properties?.["view:azimuth"]);
      return Number.isFinite(azimuth) && Math.abs(((azimuth - heading) % 360 + 540) % 360 - 180) < 90;
    };
    try {
      const feature = (heading != null ? await Carte.nearestPhoto(map, lng, lat, (f) => passesFilter(f) && sameWay(f), radius) : null)
        || await Carte.nearestPhoto(map, lng, lat, passesFilter, radius);
      if (feature) openPhoto(feature);
      else say(filterActive() ? "Aucune photo près de ce point avec le filtre (Réglages ⚙)." : "Aucune photo près de ce point : touchez le filaire orange.");
    } catch (error) {
      say(`Recherche impossible : ${error.message}`);
    }
  }

  function openPhoto(feature) {
    setPhoto(feature);
    $("#invite").hidden = true;
    viewer.hidden = false;
    if (viewer.getAttribute("picture") !== feature.id) {  // séquence et photo ensemble (voir app.js, openPhoto)
      if (viewer.select) viewer.select(feature.collection || null, feature.id, true);
      else viewer.setAttribute("picture", feature.id);
    }
    attachViewer();
  }

  function setPhoto(feature) {
    photo = feature;
    store.set("photo", feature.id);
    const producer = itemProducer(feature);
    if (producer) addProducer(producer);
    $("#capture").disabled = false;
    showCone();
    map.easeTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 17), duration: 400 });
    showPlace(feature);
    backgroundsAt(feature);
  }

  /** PCRS proposé là où il est publié ; ortho-express de l'année de la photo (comme app.js, photoDetails). */
  function backgroundsAt(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    Carte.pcrsAt(map, lon, lat).then((zone) => {
      if (photo === feature) $("#fond option[value=pcrs]").disabled = !zone;
    }).catch(() => {});
    const year = Number((feature.properties?.datetime || "").slice(0, 4));
    if (year) {
      Carte.setExpressYear(map, year, lon, lat).then((used) => {
        if (photo === feature) $("#fond option[value=express]").textContent = used == null ? "Ortho-express (aucune ici)" : `Ortho-express ${used}`;
      }).catch(() => {});
    }
  }

  async function showPlace(feature) {
    $("#lieu").hidden = true;
    const { text } = await Lieu.describe(...feature.geometry.coordinates.slice(0, 2), feature).catch(() => ({ text: "" }));
    if (photo !== feature) return;
    $("#lieu").textContent = text;
    $("#lieu").hidden = !text;
  }

  function viewHeading() {
    const azimuth = photo?.properties?.["view:azimuth"];
    if (azimuth == null) return null;
    return ((psv ? psv.getPosition().yaw : 0) * 180 / Math.PI + Number(azimuth) + 360) % 360;
  }
  function showCone() {
    if (photo) Carte.showView(map, photo.geometry.coordinates, viewHeading(), psv?.state?.hFov || 90);
  }

  function attachViewer() {
    if (psv) return;
    const timer = setInterval(() => {
      if (!viewer.psv) return;
      clearInterval(timer);
      psv = viewer.psv;
      psv.addEventListener("position-updated", showCone);
      psv.addEventListener("zoom-updated", showCone);
      psv.addEventListener("picture-loading", waitParcel);
      psv.addEventListener("picture-loaded", async (event) => {  // flèches de la visionneuse : photo voisine
        const id = event.detail?.picId;
        if (!id || id === photo?.id) return;
        const feature = await Carte.photoById(id).catch(() => null);
        if (feature) setPhoto(feature);  // flèches de la visionneuse : la photo voisine, même hors du filtre
      });
    }, 100);
  }

  map.on("click", (event) => openNearest(event.lngLat.lng, event.lngLat.lat));

  // Réglages de la carte : fond, PR, cadastre (parcelles sur la carte, étiquette de la parcelle visée dans la photo) ---

  $("#ouvrir-reglages").addEventListener("click", () => $("#reglages").showModal());
  $("#reglages").addEventListener("click", (event) => { if (event.target === $("#reglages")) $("#reglages").close(); });  // appui hors du panneau
  $("#fond").value = store.get("fond", "plan");
  if (!$("#fond").value) $("#fond").value = "plan";  // fond gardé qui n'existe plus
  $("#fond").addEventListener("change", (event) => {
    Carte.setBackground(map, event.target.value);
    store.set("fond", event.target.value);
  });
  $("#filaire").checked = store.get("filaire", "1") === "1";  // comme la page principale
  $("#filaire").addEventListener("change", (event) => {
    Carte.setNetworkVisible(map, event.target.checked);
    store.set("filaire", event.target.checked ? "1" : "0");
  });
  $("#bornes").checked = store.get("bornes") !== "0";
  Carte.setMilestones(map, $("#bornes").checked);
  $("#bornes").addEventListener("change", (event) => {
    Carte.setMilestones(map, event.target.checked);
    store.set("bornes", event.target.checked ? "1" : "0");
  });
  $("#lien-complet").checked = store.get("mobile-lien-complet") !== "0";
  $("#version-complete").hidden = !$("#lien-complet").checked;
  $("#lien-complet").addEventListener("change", (event) => {
    $("#version-complete").hidden = !event.target.checked;
    store.set("mobile-lien-complet", event.target.checked ? "1" : "0");
  });
  $("#cadastre").checked = store.get("cadastre") === "1";
  Carte.setCadastre(map, $("#cadastre").checked);
  $("#cadastre").addEventListener("change", (event) => {
    Carte.setCadastre(map, event.target.checked);
    store.set("cadastre", event.target.checked ? "1" : "0");
    if (!event.target.checked) showParcelMark();
  });

  // Filtre des photos : instance, producteur, date ; même enregistrement que la page principale (app.js, currentFilter),
  // précision GPS et type gardés tels quels (réglés sur la page principale)
  const DEFAULT_INSTANCE = "https://panoramax.ign.fr";
  const DEFAULT_PRODUCER = ["8f943f10-a781-4e03-a18c-de035be6f6f8", "conseil départemental de la côte-d'or"];
  let filter = { since: null, kind: null, max_gps: null, producer: DEFAULT_PRODUCER };
  try { filter = { ...filter, ...JSON.parse(store.get("filtre", "{}")) }; } catch { /* illisible : par défaut */ }
  const filterActive = () => Object.values(filter).some((v) => v != null);
  /** Comme py/core/filters.py (PhotoFilter.matches) : critère absent de la fiche, photo refusée. */
  function passesFilter(item) {
    const props = item.properties || {};
    if (filter.since && String(props.datetime || "").slice(0, 10) < filter.since) return false;
    if (filter.kind && (Number(props["pers:interior_orientation"]?.field_of_view || 0) >= 360) !== (filter.kind === "360")) return false;
    if (filter.max_gps != null && !(Number(props["quality:horizontal_accuracy"]) <= filter.max_gps)) return false;
    if (filter.producer && !(item.providers || props.providers || []).some((p) => p.id === filter.producer[0])) return false;
    return true;
  }
  /** Comme py/core/filters.py (item_producer) : [identifiant, nom] du producteur, ou null. */
  function itemProducer(item) {
    const p = (item.providers || item.properties?.providers || []).find((q) => q.roles?.includes("producer") && q.id);
    return p ? [p.id, p.name || p.id] : null;
  }
  function addProducer(producer) {
    const value = JSON.stringify(producer);
    if (![...$("#producteur").options].some((o) => o.value === value)) $("#producteur").append(new Option(producer[1], value));
  }
  addProducer(DEFAULT_PRODUCER);
  if (filter.producer) addProducer(filter.producer);
  $("#producteur").value = filter.producer ? JSON.stringify(filter.producer) : "";
  $("#depuis").value = filter.since || "";
  function applyFilter() {
    filter = { ...filter, producer: $("#producteur").value ? JSON.parse($("#producteur").value) : null, since: $("#depuis").value || null };
    store.set("filtre", JSON.stringify(filter));
    Carte.setFilter(map, filter);
  }
  map.on("load", () => Carte.setFilter(map, filter));
  for (const id of ["#producteur", "#depuis"]) $(id).addEventListener("change", applyFilter);

  const savedInstance = store.get("instance", DEFAULT_INSTANCE);
  if (savedInstance) $("#instance").append(new Option(savedInstance, savedInstance));
  $("#instance").value = savedInstance;
  viewer.setAttribute("endpoint", Carte.setInstance(map, savedInstance));
  Carte.instances().then((list) => {
    for (const [name, url] of list) {
      if (url !== savedInstance) $("#instance").append(new Option(name, url));
      else $("#instance").options[1].text = name;
    }
  }).catch(() => {});
  $("#instance").addEventListener("change", (event) => {
    store.set("instance", event.target.value);
    viewer.setAttribute("endpoint", Carte.setInstance(map, event.target.value));
  });

  // Comme app.js (showParcelMark), sans le calcul : sol supposé de niveau, caméra à CAMERA_UP m
  const PARCEL_ID = "mesure-parcelle", PARCEL_UP = 1.5, CAMERA_UP = 1.9, PARCEL_DELAY = 2000;
  let parcelReady = true, parcelTimer = null;
  Carte.onAim(() => showParcelMark());
  function waitParcel() {  // nouvelle photo : étiquette posée après sa HD (sinon elle saute)
    clearTimeout(parcelTimer);
    parcelReady = false;
    showParcelMark();
    parcelTimer = setTimeout(() => { parcelReady = true; showParcelMark(); }, PARCEL_DELAY);
  }
  const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function showParcelMark() {
    const markers = psv?.getPlugin?.("markers");
    if (!markers) return;
    const parcel = parcelReady && photo ? Carte.aimedParcel() : null;
    let shown = null;
    try { shown = markers.getMarker(PARCEL_ID); } catch { /* pas encore posée */ }
    if (!parcel) {
      if (shown) markers.removeMarker(PARCEL_ID);
      return;
    }
    const [lon, lat] = photo.geometry.coordinates, k = 111320 * Math.cos(lat * Math.PI / 180);
    const x = (parcel.at[0] - lon) * k, y = (parcel.at[1] - lat) * 111320;
    const yaw = Math.atan2(x, y) - Number(photo.properties?.["view:azimuth"] || 0) * Math.PI / 180;
    const pitch = -Math.atan2(CAMERA_UP - PARCEL_UP, Math.max(Math.hypot(x, y), 0.5));
    const config = { id: PARCEL_ID, position: { yaw, pitch }, anchor: "center center",
      html: `<div class="parcelle-visee"><span>${escapeHtml(parcel.section)}</span><span>${escapeHtml(parcel.numero)}</span></div>` };
    if (shown) markers.updateMarker(config);
    else markers.addMarker(config);
  }

  // Capture : la vue, l'étiquette de la parcelle et les cartouches, partagée (ou téléchargée) ---

  /** Texte d'attribution : comme py/core/capture.py (caption_for), auteur, date de Paris en toutes lettres, licence. */
  function caption(feature) {
    const props = feature.properties || {};
    const author = (props.providers || feature.providers || []).find((p) => p?.name)?.name;
    const when = props.datetime ? new Date(props.datetime) : null;
    const date = when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).replace(/^1 /, "1er ") : "";
    const link = (feature.links || []).find((l) => l.rel === "license");
    const license = props.license && props.license !== "proprietary" ? props.license
      : /\(([^()]+)\)\s*$/.exec(link?.title || "")?.[1] || link?.title || "";
    return ["Panoramax", author && `© ${author}`, date, license].filter(Boolean).join("  ·  ");
  }

  function thumbnail() {
    const r = psv.renderer;
    r.renderer.render(r.scene, r.camera);  // image WebGL lue juste après son rendu
    const gl = r.renderer.domElement, origin = gl.getBoundingClientRect(), scale = gl.width / gl.clientWidth;
    const canvas = Object.assign(document.createElement("canvas"), { width: gl.width, height: gl.height });
    const ctx = canvas.getContext("2d");
    ctx.drawImage(gl, 0, 0);
    for (const el of psv.container.querySelectorAll(".parcelle-visee")) {  // comme app.js (thumbnail)
      const box = el.getBoundingClientRect(), css = getComputedStyle(el);
      if (!box.width) continue;
      ctx.save();
      ctx.font = `${css.fontWeight} ${parseFloat(css.fontSize) * scale}px ${css.fontFamily}`;
      Object.assign(ctx, { textAlign: "center", textBaseline: "middle", strokeStyle: "#fff", lineWidth: 3 * scale, lineJoin: "round", fillStyle: css.color });
      const lines = [...el.children].map((span) => span.textContent), x = (box.left + box.width / 2 - origin.left) * scale;
      lines.forEach((text, i) => {
        const y = (box.top - origin.top + box.height * (i + 0.5) / lines.length) * scale;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      });
      ctx.restore();
    }
    Vignette.cartouches(ctx, canvas, 13 * scale, caption(photo), $("#lieu").hidden ? "" : $("#lieu").textContent);
    return canvas;
  }

  $("#capture").addEventListener("click", async () => {
    if (!psv || !photo) return;
    try {
      await document.fonts?.load("500 12px Inter").catch(() => {});
      const blob = await new Promise((resolve) => thumbnail().toBlob(resolve, "image/png"));
      const date = (photo.properties?.datetime || "").replace(/[^0-9]/g, "").slice(0, 8) || "sansdate";
      const file = new File([blob], `panoramax_${date}_${photo.id.slice(0, 8)}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] }).catch((error) => { if (error.name !== "AbortError") throw error; });
      } else {  // sans partage : téléchargement
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
    } catch (error) {
      say(`Capture impossible : ${error.message}`);
    }
  });

  // Poignée : partage de l'écran entre la photo et la carte (gardé) ------------------------------

  const SHARE_MIN = 0.2, SHARE_MAX = 0.8;
  function setShare(share) {
    share = Math.min(SHARE_MAX, Math.max(SHARE_MIN, share));
    document.body.style.gridTemplateRows = `auto ${share * 100}fr 14px ${(1 - share) * 100}fr`;  // fr sous 1 : place laissée vide
    map.resize();
    return share;
  }
  let share = setShare(Number(store.get("mobile-partage", "0.55")) || 0.55);
  $("#poignee").addEventListener("pointerdown", (event) => {
    const handle = event.currentTarget, top = $("#vue").getBoundingClientRect().top;
    const height = window.innerHeight - top - handle.offsetHeight;
    handle.setPointerCapture(event.pointerId);
    const move = (e) => { share = setShare((e.clientY - top) / height); };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      store.set("mobile-partage", String(share));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });

  // Dernière photo de la visite précédente ----------------------------------------------------

  const saved = store.get("photo");
  if (saved) {
    Carte.photoById(saved).then((feature) => {
      if (!feature || photo) return;
      openPhoto(feature);
      map.jumpTo({ center: feature.geometry.coordinates, zoom: 17 });
    }).catch(() => {});
  }

  window.mobile = { map, openPhoto, get psv() { return psv; }, thumbnail, caption };  // essais
})();
