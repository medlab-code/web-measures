// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Page de mesure : la carte choisit la photo, la visionneuse Panoramax reçoit les clics,
// le cœur de calcul du plugin (Pyodide, voir calcul.js) fait les mesures et les calages.
// Mêmes fonctions que le plugin QGIS Visionneuse Panoramax.

(() => {
  const $ = (selector) => document.querySelector(selector);

  // Services qui ne répondent pas (panne, réseau, plus de SILENT_AFTER ms sans réponse, erreur
  // HTTP 5xx) : signalés discrètement sous les voyants, jusqu'à leur réponse suivante. Toutes les
  // requêtes de la page passent par fetch, celles du calcul Python (pyfetch) comprises ; les refus
  // en rafale (HTTP 429), retentés, ne comptent pas.
  const SILENT_AFTER = 10000;
  const SERVICE_NAMES = [
    ["data.geopf.fr/altimetrie", "IGN altimétrie"],
    ["data.geopf.fr/wfs", "IGN BD TOPO"],
    ["data.geopf.fr/geocodage", "IGN recherche de lieux"],
    ["data.geopf.fr", "Géoplateforme IGN"],
    ["cdn.proj.org", "grille du géoïde (PROJ)"],
  ];
  const silent = new Set();  // noms des services sans réponse
  let lastLights = [];  // voyants affichés (redessinés quand un service se tait ou répond)
  let tiltReason = null;  // pourquoi l'inclinaison automatique manque (state.tilt_reason, ticket #29)
  function serviceName(url) {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return null;
    }
    if (!parsed.protocol.startsWith("http") || parsed.origin === location.origin) return null;
    const found = SERVICE_NAMES.find(([prefix]) => (parsed.host + parsed.pathname).startsWith(prefix));
    return found ? found[1] : parsed.pathname.includes("/api/") ? `Panoramax (${parsed.host})` : parsed.host;
  }
  function markService(name, failing) {
    if (silent.has(name) === failing) return;
    if (failing) silent.add(name);
    else silent.delete(name);
    showLights();
  }
  const nativeFetch = window.fetch.bind(window);
  const trackedFetch = (input, init) => {
    const name = serviceName(input?.url ?? String(input));
    if (!name) return nativeFetch(input, init);
    const timer = setTimeout(() => markService(name, true), SILENT_AFTER);
    return nativeFetch(input, init).then((response) => {
      clearTimeout(timer);
      if (response.status !== 429) markService(name, response.status >= 500);
      return response;
    }, (error) => {
      clearTimeout(timer);
      if (error?.name !== "AbortError") markService(name, true);  // AbortError : requête annulée par la page
      throw error;
    });
  };

  // Cache des réponses des services géographiques (ticket #23) : BD TOPO, PR et ponts (WFS), altitudes
  // (LiDAR HD, RGE ALTI), communes (WFS). Gardées d'une session à l'autre (Cache API), resservies sans requête
  // pendant CACHE_LIFE (réponse vide : CACHE_EMPTY_LIFE, le LiDAR HD se publie peu à peu), et au-delà
  // quand le service ne répond pas ou refuse. Ni Panoramax (nouvelles photos), ni la recherche de lieux,
  // ni les fonds de carte (cache HTTP du navigateur). Cache API absente (file://) : requêtes directes.
  const GEO_CACHE = "web-measures-geo";
  const CACHED_SERVICES = ["data.geopf.fr/wfs", "data.geopf.fr/altimetrie"];
  const CACHE_LIFE = 90 * 86400e3;  // ms : mises à jour trimestrielles de la BD TOPO
  const CACHE_EMPTY_LIFE = 7 * 86400e3;
  const CACHE_MAX = 50e6;  // octets : au-delà, les réponses les plus anciennes sont supprimées
  let geoCache = null;  // promesse du cache (résolue à null s'il est indisponible)
  let geoStored = 0;
  function openGeoCache() {
    geoCache ??= window.caches ? caches.open(GEO_CACHE).catch(() => null) : Promise.resolve(null);
    return geoCache;
  }
  function geoCacheable(url, init) {
    if ((init?.method || "GET") !== "GET" || init?.cache === "no-store") return false;  // no-store : vérification d'accès
    try {
      const parsed = new URL(url, location.href);
      return CACHED_SERVICES.some((prefix) => (parsed.host + parsed.pathname).startsWith(prefix));
    } catch {
      return false;
    }
  }
  function emptyAnswer(text) {  // rien à cet endroit : pas de tronçon, de commune ni d'altitude
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) return !data.length;
      if (Array.isArray(data.features)) return !data.features.length;
      if (Array.isArray(data.elevations)) return data.elevations.every((z) => !(Number(z?.z ?? z) > -9999));
    } catch { /* pas du JSON */ }
    return false;
  }
  async function storeGeo(cache, url, response) {
    const text = await response.text();
    const headers = new Headers(response.headers);
    headers.set("x-mis-en-cache", String(Date.now()));
    headers.set("x-vide", emptyAnswer(text) ? "1" : "0");
    headers.set("x-taille", String(new Blob([text]).size));
    await cache.put(url, new Response(text, { status: response.status, statusText: response.statusText, headers }));
    if (geoStored++ % 50 === 0) pruneGeoCache();  // taille contrôlée de temps en temps
  }
  /** Réponses du cache supprimées, les plus anciennes d'abord, jusqu'à CACHE_MAX (limit : 0 vide tout) ;
   * rend la taille restante (octets), ou null sans cache. */
  async function pruneGeoCache(limit = CACHE_MAX) {
    const cache = await openGeoCache();
    if (!cache) return null;
    const entries = await Promise.all((await cache.keys()).map(async (request) => {
      const headers = (await cache.match(request))?.headers;
      return { request, date: Number(headers?.get("x-mis-en-cache")) || 0, size: Number(headers?.get("x-taille")) || 0 };
    }));
    entries.sort((a, b) => a.date - b.date);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (total <= limit) break;
      await cache.delete(entry.request);
      total -= entry.size;
    }
    return total;
  }
  window.fetch = async (input, init) => {
    const url = input?.url ?? String(input);
    const cache = geoCacheable(url, init) ? await openGeoCache() : null;
    if (!cache) return trackedFetch(input, init);
    const hit = await cache.match(url).catch(() => undefined);
    const age = hit ? Date.now() - Number(hit.headers.get("x-mis-en-cache")) : Infinity;
    if (hit && age < (hit.headers.get("x-vide") === "1" ? CACHE_EMPTY_LIFE : CACHE_LIFE)) return hit;
    try {
      const response = await trackedFetch(input, init);
      if (response.ok) storeGeo(cache, url, response.clone()).catch((error) => console.warn("Cache :", error));
      return !response.ok && hit ? hit : response;  // refus ou erreur : la réponse plus ancienne
    } catch (error) {
      if (hit && error?.name !== "AbortError") return hit;  // service muet ou en panne : idem
      throw error;
    }
  };

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

  // Services : bilan dans la section, point rouge sur son bouton du pied s'il en manque
  Services.checkServices($("#reseau ul"), (ok, failed, total) => {
    const waiting = total - ok - failed;
    $("#reseau-infos").textContent = failed ? `${failed} sans réponse ou bloqué${failed > 1 ? "s" : ""} sur ${total}`
      : `${ok} services sur ${total} accessibles${waiting ? ` · ${waiting} en cours` : ""}`;
    $("#services-alerte").textContent = failed ? "●" : "";
  });
  // Cache des informations géographiques : taille, et bouton pour le vider
  async function showGeoCache() {
    const size = await pruneGeoCache();
    $("#vider-cache").disabled = !size;  // indisponible (null) ou déjà vide
    $("#vider-cache").textContent = size === null ? "Cache indisponible (page ouverte en fichier local)"
      : `Vider le cache (${(size / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo)`;
  }
  // Panneau : une section affichée à la fois, choisie par les onglets (Résultats, Photo, Favoris,
  // Couche, Parcours) ou les outils du pied (Mesure, Filtre, Réglages, Services) ; la dernière est rouverte à la visite suivante
  const paneButtons = [...document.querySelectorAll("#panneau [data-panneau]")];
  function showPane(id) {
    if (!paneButtons.some((b) => b.dataset.panneau === id)) id = "resultats";
    for (const button of paneButtons) {
      const on = button.dataset.panneau === id;
      button.setAttribute(button.getAttribute("role") === "tab" ? "aria-selected" : "aria-pressed", String(on));
      $(`#${button.dataset.panneau}`).hidden = !on;
    }
    $("#contenu-panneau").scrollTop = 0;
    store.set("panneau", id);
    if (id === "reseau") showGeoCache();
  }
  for (const button of paneButtons) button.addEventListener("click", () => showPane(button.dataset.panneau));
  showPane(store.get("panneau", "resultats"));
  $("#vider-cache").addEventListener("click", async () => {
    await pruneGeoCache(0);
    showGeoCache();
  });

  // Fond, instance, centrage ----------------------------------------------------------------

  $("#fond").value = store.get("fond", "plan");
  if (!$("#fond").value) $("#fond").value = "plan";  // fond mémorisé qui n'existe plus
  map.on("load", () => Carte.setBackground(map, $("#fond").value));
  // Police des cartouches prête avant qu'ils ne soient dessinés
  document.fonts?.load("700 24px Inter").catch(() => {});
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
  // Inclinaison par le terrain hors agglomération (expérimental, ticket #29) : décochée par défaut
  $("#inclinaison-terrain").checked = store.get("inclinaison-terrain") === "1";
  $("#inclinaison-terrain").addEventListener("change", (event) => {
    store.set("inclinaison-terrain", event.target.checked ? "1" : "0");
    if (app) refresh(app.set_terrain_relay(event.target.checked));
  });
  // Bords de route (chute et dévers, ticket #31) : calculés à l'appui sur « Dévers », jusqu'à la
  // distance de la réglette, gardée dans le navigateur
  const edgeZone = $("#bords-largeur");
  edgeZone.value = store.get("bords", edgeZone.value);
  const showEdgeZone = () => { $("#bords-valeur").textContent = `${edgeZone.value} m`; };
  showEdgeZone();
  edgeZone.addEventListener("input", showEdgeZone);
  edgeZone.addEventListener("change", () => {
    store.set("bords", edgeZone.value);
    if (app) { app.set_edge_zone(Number(edgeZone.value)); refresh(); }
  });
  $("#bords").addEventListener("click", () => { app.request_edges(); refresh(); });
  // « Profil » : coupe du terrain du dernier calcul de « Dévers » pour la photo affichée
  let edgeProfile = null;
  // Case « Hauteurs à l'échelle » : cochée à chaque ouverture du profil (caméra à sa hauteur), jamais grisée
  const trueScale = $("#profil-echelle");
  // Case « Végétation » (analyse fine : ligne verte, herbe), de même retenue ; cochée par défaut, grisée sans analyse fine
  const plants = $("#profil-vegetation");
  plants.checked = store.get("profil-vegetation") !== "0";
  plants.addEventListener("change", () => {
    store.set("profil-vegetation", plants.checked ? "1" : "0");
    if (edgeProfile) drawProfile();
  });
  trueScale.checked = true;
  const drawProfile = () => {
    const dialog = $("#fenetre-profil"), { svg, legend, long } = Profil.draw(edgeProfile.profile, trueScale.checked, nuage.get(nuageKey(edgeProfile.profile)), plants.checked,
      Number($("#camera").value) || 1.9);  // hauteur de caméra des réglages
    dialog.querySelector(".graphique").replaceChildren(svg, ...(long ? [long] : []));  // profil en long dessous
    $("#profil-pdf-long").disabled = !long;  // pas de 2e page sans profil en long
    dialog.querySelector(".legende").replaceChildren(legend);
  };
  trueScale.addEventListener("change", () => {
    if (edgeProfile) drawProfile();
  });
  // Loupe : graphique le plus grand possible (sans la légende) sans que la fenêtre dépasse de la visionneuse ;
  // l'image PNG n'en dépend pas
  const fitProfile = () => {
    const dialog = $("#fenetre-profil"), chart = dialog.querySelector(".graphique");
    chart.style.width = "";
    dialog.style.maxWidth = "";
    if (!dialog.classList.contains("agrandi")) return;
    const box = $("#vue").getBoundingClientRect();
    const ratio = chart.offsetWidth / (chart.offsetHeight || 1);  // les deux graphiques (en travers, en long) ensemble
    // Marges de la fenêtre en largeur ; en hauteur, place prise par le reste (titre, boutons), mesurée graphique compris
    const css = getComputedStyle(dialog), otherW = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
      .reduce((sum, k) => sum + parseFloat(css[k]), 0), otherH = dialog.offsetHeight - chart.offsetHeight;
    const width = Math.max(200, Math.floor(Math.min(box.width - 16 - otherW, (box.height - 16 - otherH) * ratio)));
    chart.style.width = `${width}px`;
    dialog.style.maxWidth = `${width + otherW}px`;  // la rangée de boutons passe à la ligne au lieu d'élargir la fenêtre
  };
  const zoomProfile = (on) => {
    const dialog = $("#fenetre-profil"), button = $("#profil-loupe");
    dialog.classList.toggle("agrandi", on);
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Taille normale du graphique" : "Agrandir le graphique");
    fitProfile();
  };
  $("#profil-loupe").addEventListener("click", () => zoomProfile(!$("#fenetre-profil").classList.contains("agrandi")));
  window.addEventListener("resize", () => { if ($("#fenetre-profil").open) fitProfile(); });
  $("#fenetre-profil").addEventListener("close", () => zoomProfile(false));  // taille normale à la prochaine ouverture
  $("#profil").addEventListener("click", () => {
    if (!edgeProfile) return;
    const dialog = $("#fenetre-profil"), feature = photo;
    const title = dialog.querySelector("h2");
    title.textContent = "Profil en travers" + (edgeProfile.road ? ` · ${edgeProfile.road}` : "");
    trueScale.checked = true;  // à l'échelle à chaque ouverture
    drawProfile();
    $("#profil-nuage-etat").textContent = "";
    nuageReady();
    showOverViewer(dialog);
    // Route, PR et commune de la photo, comme l'étiquette du lieu (déjà lus : sans requête)
    Lieu.describe(...feature.geometry.coordinates.slice(0, 2)).then(({ parts }) => {
      const place = [parts.voie || edgeProfile.road, parts.pr, parts.commune].filter(Boolean).join(" – ");
      if (place && photo === feature && dialog.open) title.textContent = `Profil en travers · ${place}`;
    }).catch(() => {});
  });
  // « Analyse fine » : nuage LiDAR HD lu pour le travers de la photo (src/nuage.js), gardé pour ce profil ; grisé pendant
  // la lecture et une fois faite
  // rangée sous le repère du travers : le calcul renvoie un nouvel objet profil à chaque rafraîchissement
  const nuage = new Map(), nuageKey = (profile) => JSON.stringify(profile?.repere);
  // « Végétation » grisée tant que l'analyse fine n'a rien fourni pour ce profil (son choix reste retenu)
  const nuageReady = () => {
    const done = nuage.has(nuageKey(edgeProfile?.profile));
    $("#profil-nuage").disabled = !edgeProfile?.profile?.repere || done;
    $("#profil-vegetation").disabled = !done;
  };
  $("#profil-nuage").addEventListener("click", async () => {
    const profile = edgeProfile?.profile, state = $("#profil-nuage-etat");
    if (!profile) return;
    $("#profil-nuage").disabled = true;
    const bar = $("#profil-nuage-barre");  // sans valeur, animée, tant que le nombre de blocs n'est pas connu
    bar.removeAttribute("value");
    bar.hidden = false;
    try {
      const found = await Nuage.analyse(profile, (text, part) => {
        state.textContent = text;
        if (part !== undefined) bar.value = part;
      });
      nuage.set(nuageKey(profile), found);
      state.textContent = `Nuage LiDAR HD : ${found.points} points du sol, ${found.requetes} requêtes, ${found.secondes} s.`;
      if (nuageKey(edgeProfile?.profile) === nuageKey(profile)) drawProfile();
    } catch (error) {
      state.textContent = `Analyse fine impossible : ${error.message}`;
    } finally {
      bar.hidden = true;
      nuageReady();
    }
  });
  $("#profil-png").addEventListener("click", async () => {
    const dialog = $("#fenetre-profil"), title = dialog.querySelector("h2").textContent;
    const id = psv?.getPictureMetadata?.()?.id || "photo";
    const save = await saveAs(`profil-${edgeProfile?.road || "route"}-${id.slice(0, 8)}.png`, "image/png");  // au clic
    if (!save) return;
    await save(await Profil.png(dialog.querySelector("svg"), title, dialog.querySelector(".legende"), dialog.querySelector("svg.profil-long")));
    setStatus("Profil enregistré en PNG.");
  });
  $("#profil-pdf-long").checked = store.get("profil-pdf-long") === "1";
  $("#profil-pdf-long").addEventListener("change", (event) => store.set("profil-pdf-long", event.target.checked ? "1" : "0"));
  $("#profil-pdf").addEventListener("click", async () => {
    const dialog = $("#fenetre-profil"), meta = psv?.getPictureMetadata?.(), feature = photo;
    const win = window.open("", "_blank", "popup,width=1120,height=800");  // au clic : pas bloquée
    if (!win) {
      setStatus("Profil en PDF : fenêtre bloquée par le navigateur (autorisez les fenêtres de cette page).", "echec");
      return;
    }
    win.document.write('<p style="font: 15px sans-serif; margin: 2rem">Préparation du PDF…</p>');
    win.document.close();
    // Lieu de la photo comme l'encart de la visionneuse (route, PR, commune ; d'ordinaire déjà lu : sans requête)
    const { text, parts } = await Lieu.describe(...feature.geometry.coordinates.slice(0, 2)).catch(() => ({ text: "" }));
    const long = $("#profil-pdf-long").checked ? dialog.querySelector("svg.profil-long") : null;
    win.document.open();
    win.document.write(Profil.pdfPage(dialog.querySelector("svg"), dialog.querySelector(".legende"), long, {
      stylesheet: new URL("src/style.css", location.href).href, fonts: FICHE_FONTS, photo: meta?.id || "",
      place: text ? placeMarkup(text, parts) : escapeHtml(edgeProfile?.road || ""),
      edited: `Édité le ${new Date().toLocaleDateString("fr-FR")}`,
    }));
    win.document.close();
    await new Promise((resolve) => (win.document.readyState === "complete" ? resolve() : win.addEventListener("load", resolve)));
    await win.document.fonts.ready;
    Profil.fit(win.document);
    win.focus();
    win.print();
  });
  // Droite de mesure tracée sur la carte (expérimental, ticket #28) : décochée, bouton non proposé
  $("#droite-carte").checked = store.get("droite-carte") === "1";
  $("#droite-carte").addEventListener("change", (event) => {
    store.set("droite-carte", event.target.checked ? "1" : "0");
    if (!app) return;
    if (!event.target.checked && lineDraft !== null) endLineDraft();
    refresh(!event.target.checked && JSON.parse(app.axis_state()).drawn ? app.cancel_measure_line() : undefined);
  });
  // Filtrage anisotrope 16x des textures du panorama (4x dans le plugin), contre le crénelage et
  // le scintillement des détails fins vus de loin. Photo Sphere Viewer crée ses textures sans
  // mipmaps, sans lesquels l'anisotropie n'a guère d'effet : on les active (trilinéaire).
  // Chaque texture n'est traitée qu'une fois ; décoché, le filtre d'origine revient.
  function anisotropic(on) {
    const r = psv?.renderer;
    if (!r?.scene?.traverse) return;
    const max = r.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
    let changed = false;
    r.scene.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        const texs = [m.map];  // matériau simple, ou textures passées au shader de l'adaptateur
        for (const u of Object.values(m.uniforms || {})) if (u?.value?.isTexture) texs.push(u.value);
        for (const t of texs) {
          if (!t?.isTexture || !t.image || !!t.webAniso === on) continue;
          t.webAniso = on;
          t.anisotropy = on ? Math.min(16, max) : 1;  // limité par la carte graphique
          t.generateMipmaps = on;
          t.minFilter = on ? 1008 : 1006;  // THREE.LinearMipmapLinearFilter : THREE.LinearFilter
          t.needsUpdate = true;
          changed = true;
        }
      }
    });
    if (changed) psv.needsUpdate?.();
  }
  // Bornes des PR sur la mini-carte (fond « orthophoto avec noms »), affichées par défaut
  $("#bornes").checked = store.get("bornes") !== "0";
  Carte.setMilestones(map, $("#bornes").checked);
  $("#bornes").addEventListener("change", (event) => {
    store.set("bornes", event.target.checked ? "1" : "0");
    Carte.setMilestones(map, event.target.checked);
  });
  // Cadastre (#36) sur la mini-carte, décoché par défaut
  $("#cadastre").checked = store.get("cadastre") === "1";
  Carte.setCadastre(map, $("#cadastre").checked);
  $("#cadastre").addEventListener("change", (event) => {
    store.set("cadastre", event.target.checked ? "1" : "0");
    Carte.setCadastre(map, event.target.checked);
  });
  $("#anisotrope").checked = store.get("anisotrope") === "1";
  $("#anisotrope").addEventListener("change", (event) => {
    store.set("anisotrope", event.target.checked ? "1" : "0");
    anisotropic(event.target.checked);
  });
  // Toutes les secondes, pour les tuiles chargées au fil de la navigation
  setInterval(() => { if ($("#anisotrope").checked) anisotropic(true); }, 1000);

  // Réglages par défaut : l'instance de l'IGN et les photos du conseil départemental de la
  // Côte-d'Or (positions RTK, LiDAR HD : ce que demandent les calculs). Appliqués une fois, même
  // dans un navigateur qui avait déjà ses réglages ; chacun peut ensuite en changer.
  const DEFAULT_INSTANCE = "https://panoramax.ign.fr";
  const DEFAULT_PRODUCER = ["8f943f10-a781-4e03-a18c-de035be6f6f8", "conseil départemental de la côte-d'or"];
  // Photo ouverte à la première utilisation (et sans dernière photo gardée) : château de Semur-en-Auxois,
  // vue tournée entre ses deux tours (cap en degrés)
  const DEFAULT_PHOTO = "7752eb30-a733-4213-b57a-5d5086e261a4";
  const DEFAULT_HEADING = 163;
  const firstUse = store.get("defauts") !== "1";
  if (firstUse) {
    showOverViewer($("#reglages-defaut"));  // pourquoi ces réglages, et où les changer
    $("#reglages-defaut").addEventListener("close", () => showTour(), { once: true });
    store.set("instance", DEFAULT_INSTANCE);
    let filter = {};
    try { filter = JSON.parse(store.get("filtre", "{}")) || {}; } catch { /* illisible : remplacé */ }
    store.set("filtre", JSON.stringify({ ...filter, producer: DEFAULT_PRODUCER }));
    store.set("defauts", "1");
  }

  if (!firstUse) showTour();  // déjà venu avant la visite guidée : une fois aussi

  /** Première visite : bulles l'une après l'autre près de la carte, du bouton Mesure et des
   * résultats, une fois par navigateur (« Passer » l'arrête). */
  function showTour() {
    if (store.get("visite") === "1") return;
    store.set("visite", "1");
    const steps = [
      ["#carte", "Cliquez sur le filaire orange de la carte (ou cherchez un lieu) pour ouvrir la photo la plus proche."],
      ["#mesure", "Activez « Mesure », choisissez largeur ou hauteur, puis cliquez dans la photo : "
        + "la carte d'étape, en bas à gauche de la visionneuse, guide chaque étape."],
      ["#resultats", "Les mesures s'affichent ici avec leur incertitude ; exportez-les en CSV ou GeoJSON "
        + "avant de fermer la page."],
    ];
    const bubble = $("#visite");
    let step = 0, target = null;
    const place = () => {
      const box = target.getBoundingClientRect(), w = bubble.offsetWidth, h = bubble.offsetHeight;
      const left = box.left > innerWidth / 2 ? box.left - w - 12 : box.left;  // colonne de droite : à gauche
      const top = box.left > innerWidth / 2 ? box.top + 12 : box.bottom + 12;  // sinon dessous
      bubble.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`;
      bubble.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, top))}px`;
    };
    const show = () => {
      target?.classList.remove("visite-cible");
      if (step >= steps.length) return;
      const [selector, text] = steps[step];
      target = $(selector);
      if (target.parentElement?.id === "contenu-panneau" && target.hidden) showPane(target.id);  // section affichée
      target.classList.add("visite-cible");
      bubble.querySelector("p").textContent = text;
      bubble.querySelector(".oui").textContent = step === steps.length - 1 ? "Terminer" : "Suivant";
      bubble.show();  // non modale : la page reste utilisable
      place();
    };
    bubble.addEventListener("close", () => {
      step = bubble.returnValue === "suivant" ? step + 1 : steps.length;
      show();
      if (step >= steps.length) window.removeEventListener("resize", place);
    });
    window.addEventListener("resize", place);
    show();
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
  /** Lieu de la photo en bas à gauche de la visionneuse. Description incomplète (service
   * refusant des requêtes en rafale) : redemandée après PLACE_RETRY ms, plusieurs fois, tant que
   * la photo est affichée ; le texte partiel s'affiche en attendant. */
  const PLACE_RETRY = [1500, 4000, 10000];

  /** Lieu (texte « D104 – PR 16 +0880 – … – Aubaine ») en HTML : la route et la commune (parts de
   * Lieu.describe) en gras, le reste (PR, nom de la voie, hameau) en texte normal. */
  function placeMarkup(text, parts) {
    const strong = [parts?.voie, parts?.commune].filter(Boolean);
    return text.split(" – ").map((part) => (strong.includes(part) ? `<b>${escapeHtml(part)}</b>` : escapeHtml(part))).join(" – ");
  }
  async function showPlace(feature, attempt = 0) {
    const [lon, lat] = feature.geometry.coordinates;
    const { text, complete, parts } = await Lieu.describe(lon, lat);
    if (photo !== feature) return;
    if (text || complete) {
      $("#lieu").innerHTML = placeMarkup(text, parts);
      $("#lieu").hidden = !text;
    }
    if (!complete && attempt < PLACE_RETRY.length) {
      setTimeout(() => { if (photo === feature) showPlace(feature, attempt + 1); }, PLACE_RETRY[attempt]);
    }
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

  // Équerre du bouton « Mesure » à la place de l'émoji « 📐 » des textes du cœur (dessin selon l'OS)
  const EQUERRE = $("#mesure svg");
  function setStatus(text, kind = "") {
    const status = $("#statut");
    status.replaceChildren(...text.split("📐").flatMap((part, i) => i ? [EQUERRE.cloneNode(true), part] : [part]));
    status.className = "statut " + kind;  // replie aussi la ligne
  }
  // Ligne d'état sur une ligne : le texte entier au clic
  $("#statut").addEventListener("click", () => $("#statut").classList.toggle("deplie"));

  // Thème : comme le système (prefers-color-scheme), ou jour / nuit forcé (data-theme, posé dès le
  // <head> pour éviter un éclair)
  $("#theme").value = store.get("theme", "");
  $("#theme").addEventListener("change", () => {
    store.set("theme", $("#theme").value);
    if ($("#theme").value) document.documentElement.dataset.theme = $("#theme").value;
    else delete document.documentElement.dataset.theme;
  });

  /** « Exporter le calage » grisé tant qu'aucune photo ni séquence n'est calée (rien à exporter). */
  function showCalibrationExport() {
    const c = JSON.parse(app.calibration_json());
    $("#calage-exporter").disabled = !["verticals", "landmarks", "heights", "auto"]
      .some((k) => c[k] && Object.keys(c[k]).length);
  }

  Calcul.startCalcul(() => refresh(), apiUrl).then((created) => {
    app = created;
    // Relevé gardé : relu avant tout rafraîchissement, qui écrirait par-dessus un relevé vide
    try { app.load_releve(store.get("releve") || ""); } catch (error) { console.warn("Relevé gardé illisible :", error); }
    const saved = store.get("calage");
    if (saved && !app.load_calibration(saved)) console.warn("Calage enregistré illisible : ignoré.");
    savedCalibration = app.calibration_version;
    for (const id of ["#mesure", "#mode", "#camera", "#pont", "#calage-importer"]) $(id).disabled = false;
    showCalibrationExport();
    $("#camera").value = store.get("camera", $("#camera").value);
    app.set_camera_height(Number($("#camera").value));
    app.set_terrain_relay($("#inclinaison-terrain").checked);
    app.set_edge_zone(Number($("#bords-largeur").value));
    applyFilter(false);
    if (photo) app.set_picture(JSON.stringify(photo));
    restoreOverlay();  // couche importée gardée de la session précédente
    showModeOptions();
    refresh();
  }).catch((error) => {
    console.error(error);
    setStatus(`Calcul indisponible : ${error.message}`, "echec");
  });

  /** Voyants de la visionneuse : RTK et sol (LiDAR HD ou RGE ALTI) toujours ; inclinaison calée en
   * mode mesure seulement (elle n'est calculée qu'au premier clic de mesure). */
  function showLights(lights = lastLights) {
    lastLights = lights;
    const list = $("#voyants");
    // Inclinaison : en mesure seulement, sauf en mesure libre (pas calculée, visées en cap)
    const shown = measuring && $("#mode").value !== "tri" ? lights : lights.filter(([name]) => name !== "Inclinaison");
    list.hidden = !shown.length && !silent.size;
    list.replaceChildren(...shown.map(([name, light]) => {
      const item = document.createElement("li");
      item.className = light === "avant" ? "attente" : light;  // avant : calcul au premier clic
      item.textContent = name;
      return item;
    }));
    if (silent.size) {  // services sans réponse, en petit sous les voyants
      list.append(Object.assign(document.createElement("li"), {
        className: "muet", textContent: `⚠ Sans réponse : ${[...silent].join(", ")}`,
        title: "Ces services ne répondent pas : ce qui en dépend (commune, route et PR, altitudes, fonds de carte…) "
          + "peut manquer ou arriver en retard. Signalé jusqu'à leur prochaine réponse.",
      }));
    }
    // Inclinaison : calcul en cours, ou calcul automatique sans résultat (calage à la main
    // conseillé, sauf pendant ce calage)
    const tilt = (lights.find(([name]) => name === "Inclinaison") || [])[1];
    const message = $("#calcul-inclinaison");
    // En calage de l'inclinaison, rappel du mode : les clics calent la photo, ils ne mesurent pas
    const calibrating = $("#mode").value === "tilt";
    const triangulating = $("#mode").value === "tri";  // pas de calcul d'inclinaison (visée en cap)
    const manual = tilt === "non" && !calibrating;
    const before = tilt === "avant" && !calibrating;  // calcul lancé au premier clic sur la photo
    message.hidden = !measuring || triangulating || !(calibrating || tilt === "attente" || manual || before);
    message.classList.toggle("manuel", manual);
    message.classList.toggle("calage", calibrating);
    message.classList.toggle("attente", tilt === "attente");  // petite roue : calcul en cours
    if (tilted !== (tilt === "ok")) {
      tilted = tilt === "ok";
      applyMeasureUi();  // pointeur : cercle vert
    }
    message.textContent = calibrating
      ? "Calage vertical" + (tilt === "attente" ? " · calcul automatique en cours" : "")
      : before
        ? "Inclinaison calculée automatiquement au premier clic sur la photo"
        : manual
          ? `Inclinaison non calée${tiltReason ? ` : ${tiltReason}` : ""}. `
            + "Les mesures sont moins précises ; leur incertitude en tient compte."
          : "Calcul de l'inclinaison en cours : attendez avant de mesurer";
  }

  /** Fenêtre modale centrée sur la visionneuse (et non sur la page), recentrée si la fenêtre du
   * navigateur change de taille. */
  function showOverViewer(dialog) {
    dialog.showModal();
    let bottom = null;  // bas de la fenêtre une fois placée : gardé quand son contenu change (case actionnée, légende plus
    // courte), pour que ses boutons, en bas, ne sautent pas sous le pointeur ; sans sortir de la visionneuse
    const place = () => {
      const box = $("#vue").getBoundingClientRect();
      dialog.style.margin = "0";
      dialog.style.inset = "auto";
      // Centrée dans la visionneuse, sans en sortir : plus haute (nombreux champs), elle défile
      dialog.style.maxHeight = `${Math.max(160, box.height - 16)}px`;
      dialog.style.left = `${Math.max(8, box.left + (box.width - dialog.offsetWidth) / 2)}px`;
      const h = dialog.offsetHeight;
      bottom ??= box.top + (box.height + h) / 2;  // centrée à l'ouverture
      bottom = Math.min(box.bottom - 8, Math.max(bottom, box.top + 8 + h));
      dialog.style.top = `${Math.max(8, bottom - h)}px`;
    };
    const resized = () => { bottom = null; place(); };  // visionneuse redimensionnée : recentrée
    place();
    window.addEventListener("resize", resized);
    const grown = new ResizeObserver(place);  // contenu changé fenêtre ouverte (modèle choisi, champs ajoutés)
    grown.observe(dialog);
    dialog.addEventListener("close", () => { window.removeEventListener("resize", resized); grown.disconnect(); }, { once: true });
  }

  /** Onglet Photo, « Position » : un élément par ligne (GPS, terrain, inclinaison, calage), chacun avec
   * son voyant, comme ceux de la visionneuse : vert vérifié ou calé, orange manquant ou en attente, gris sinon
   * (le ⚠ de la ligne d'état porte sur l'élément en cause, pas sur les autres). */
  let shownPosition = "";
  function showPosition(quality, calibration) {
    const key = `${quality}\n${calibration}`;
    if (key === shownPosition) return;
    shownPosition = key;
    const parts = [...quality.replace(/^⚠ /, "").split(" · "), ...(calibration ? [calibration] : [])].filter(Boolean);
    $("#qualite").replaceChildren(...parts.map((text) => {
      const wait = /\bnon\b|pas de|pas assez|en cours|activation|estimée|dégradé|calez/i.test(text);
      const ok = !wait && /vérifiée|LiDAR|RGE ALTI|corrigée|calée|caméra à/i.test(text);
      const li = Object.assign(document.createElement("li"), { textContent: text[0].toUpperCase() + text.slice(1) });
      li.className = ok ? "ok" : wait ? "attente" : "";
      return li;
    }));
  }

  /** Fenêtre non modale en haut à gauche de la visionneuse, sous le nom du pont : la photo reste
   * visible et utilisable (question du pont, posée à l'ouverture d'une photo). */
  function showInCorner(dialog) {
    dialog.show();
    const box = $("#vue").getBoundingClientRect(), fall = $("#chute");
    Object.assign(dialog.style, { margin: "0", inset: "auto", left: `${box.left + 12}px`,
      top: `${box.top + 12 + (fall.hidden ? 0 : fall.offsetHeight + 8)}px` });
  }

  /** Redessine tout : texte de la mesure, état de la photo, repères, carte, résultats. */
  function refresh(text) {
    if (!app) return;
    setStatus(text ?? app.status());
    const rtkAlert = app.take_rtk_alert();  // séquence sans RTK : fenêtre, une fois par séquence
    if (rtkAlert && !$("#alerte-rtk").open) {
      $("#alerte-rtk p").textContent = rtkAlert;
      showOverViewer($("#alerte-rtk"));
    }
    // Photo sur un pont (BD TOPO) : « Sur un pont » proposé, une fois par pont ; sortie du pont : la
    // décocher, une fois par sortie. Sans autre fenêtre ouverte.
    const bridgeAlert = document.querySelector("dialog[open]") ? null : JSON.parse(app.take_bridge_alert());
    if (bridgeAlert) {
      const dialog = $("#alerte-pont");
      dialog.querySelector("h2").textContent = bridgeAlert.check ? "⚠ Photo sur un pont" : "Sortie du pont";
      dialog.querySelector("p").textContent = bridgeAlert.text;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => {
        if (dialog.returnValue !== "oui") return;
        $("#pont").checked = bridgeAlert.check;
        refresh(bridgeAlert.check ? app.set_bridge(true) : app.leave_bridge());
      }, { once: true });
      showInCorner(dialog);
    }
    const state = JSON.parse(app.state());
    $("#effacer").disabled = !state.can_undo;  // grisés quand ils n'auraient pas d'effet
    $("#refaire").disabled = !state.can_redo;
    $("#tout-effacer").disabled = !state.can_clear;
    const computed = $("#fiche .precision-calculee");
    if (computed) computed.textContent = state.computed || "en cours…";
    showPosition(state.quality, state.calibration);
    const gps = $("#camera-gps");
    gps.hidden = !state.camera;
    if (state.camera) {
      gps.textContent = `Caméra à ${String(state.camera[0]).replace(".", ",")} m d'après l'altitude GPS : utiliser`;
      gps.title = state.camera[1];
      gps.dataset.value = state.camera[0];
    }
    tiltReason = state.tilt_reason;
    showLights(state.lights);
    // Photo sur un pont, en haut à gauche : nom et hauteur de chute ; ailleurs, chute et dévers des
    // bords de route après un appui sur « Dévers » (pas pendant la lecture)
    const fall = playing() ? null : JSON.parse(app.fall_json());
    const [bridge, ...rest] = (fall?.text || "").split("\n");
    Object.assign($("#chute"), { hidden: !fall, title: fall?.title || "" });
    $("#bords").disabled = playing() || (fall && !fall.edges) || !app.edges_ready();  // pas sur un pont
    edgeProfile = fall?.profile ? fall : null;
    $("#profil").disabled = !edgeProfile;
    // Nom du pont en vert, « Au-dessus de … » en bleu, puis la hauteur
    const line = (text, className) => Object.assign(document.createElement("span"), { className, textContent: text });
    $("#chute").replaceChildren(line(bridge, "pont"),
      ...rest.flatMap((t) => ["\n", t.startsWith("Au-dessus") ? line(t, "dessus") : t]));
    if (fall?.ask) {  // hauteur de caméra ni mesurée ni calée : le réglage, si l'utilisateur l'accepte (App.use_fall_setting)
      const ask = Object.assign(document.createElement("button"), { type: "button", className: "chute-reglage", textContent: fall.ask });
      ask.addEventListener("click", () => refresh(app.use_fall_setting()));
      $("#chute").append("\n", ask);
    }
    pointReady = state.point;
    singleM = state.single_m;
    tiltReady = state.tilt_ready;
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
    // Visées suivantes (point de référence, bord B) : vue tournée vers le point, zoom gardé
    if (photoReady()) frameView(JSON.parse(app.take_aim_frame()), true);
    if (app.calibration_version !== savedCalibration) {
      savedCalibration = app.calibration_version;
      store.set("calage", app.calibration_json());
      showCalibrationExport();
    }
    drawViewerMarks(JSON.parse(app.viewer_marks()));
    heightAxis = JSON.parse(app.height_axis());
    if (!heightAxis && slideKind === "hauteur") slideOnGuide(null);
    Carte.showMeasures(map, JSON.parse(app.map_geojson()));
    Carte.showHandles(map, JSON.parse(app.handles()), (index, lon, lat) => refresh(app.move_handle(index, lon, lat)));
    frame(app.focus());
    showResults(JSON.parse(app.results()));
    saveResults();
    const results = app.has_results();
    $("#csv").disabled = !results;
    $("#geojson").disabled = !results;
    saveReleve();
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
    const ol = $("#resultats > ol");
    $("#compte-resultats").textContent = list.filter((r) => !r.sous).length || "";
    const focused = document.activeElement?.closest?.("#resultats > ol") ? document.activeElement.dataset.key : null;
    ol.replaceChildren(...list.map((r) => {
      const li = Object.assign(document.createElement("li"), { className: r.sous ? "sous" : "" });  // mesure d'un point de référence
      const text = resultLabel(r);
      const comment = Object.assign(document.createElement("input"), {
        type: "text", value: r.comment, placeholder: "Commentaire", title: "Commentaire exporté avec le résultat",
        hidden: !r.comment && focused !== `${r.kind}-${r.id}`,  // ouvert par ✎ ; montré s'il existe
      });
      comment.dataset.key = `${r.kind}-${r.id}`;
      comment.addEventListener("input", () => {
        app.set_comment(r.kind, r.id, comment.value);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveResults, 1000);
      });
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
      line.append(text);
      if (r.kind === "point" && !r.releve) {  // point de référence : sa fiche PDF, avec ses mesures
        const sheet = Object.assign(document.createElement("button"), {
          type: "button", className: "fiche", title: "Fiche PDF de ce point et de ses mesures (impression du navigateur)",
          innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
            + '<path d="M7 3h7l5 5v13H7z M14 3v5h5" stroke-linejoin="round"/></svg>',
        });
        sheet.setAttribute("aria-label", `Fiche PDF : ${r.text}`);
        sheet.addEventListener("click", () => askFiche(r.id, r.text));
        line.append(sheet);
      }
      const edit = Object.assign(document.createElement("button"), {
        type: "button", className: "effacer-resultat", textContent: "✎", title: "Commentaire exporté avec le résultat",
      });
      edit.setAttribute("aria-label", `Commentaire : ${r.text}`);
      if (r.releve) edit.title = "Champs de l'objet";
      edit.addEventListener("click", () => {
        if (r.releve) return editReleve(r.id);
        comment.hidden = false;
        comment.focus();
      });
      line.append(edit, remove);
      li.append(line, comment);
      return li;
    }));
    if (focused) ol.querySelector(`[data-key="${focused}"]`)?.focus();
    showResultsInfo(list);
  }

  /** Libellé d'un résultat : point de référence (pastille, incertitude) ou mesure (symbole, point
   * d'arrivée, valeur, incertitude) ; autre forme (distance…) : le texte tel quel. */
  function resultLabel(r) {
    const span = (className, textContent) => Object.assign(document.createElement("span"), { className, textContent });
    const label = span("libelle", "");
    const point = r.kind === "point" && r.text.match(/^Point (\S+) (±.+)$/);
    const measure = r.kind === "mesure" && r.text.match(/^(\S+) ([A-Za-z]\S*) (\d.*?) (± .+)$/);
    if (point) label.append(span("puce-point", point[1]), span("valeur", "Point de référence"), span("incert", point[2]));
    else if (measure) label.append(span("symbole", measure[1]), span("puce-point fin", measure[2]), span("valeur", measure[3]),
      span("incert", measure[4]));
    else label.textContent = r.text;
    label.title = r.text;
    return label;
  }

  /** En-tête des résultats : points et mesures, exportés ou non ; accueil s'il n'y en a pas. */
  let shownResults = [];
  function showResultsInfo(list = shownResults) {
    shownResults = list;
    const measured = list.filter((r) => !r.releve);  // objets relevés : leur propre en-tête (saveReleve)
    const points = measured.filter((r) => r.kind === "point").length, others = measured.length - points;
    const parts = [points && `${points} point${points > 1 ? "s" : ""}`, others && `${others} mesure${others > 1 ? "s" : ""}`]
      .filter(Boolean);
    const done = Boolean(measured.length) && exported === app.export_geojson();
    $("#resultats-infos").textContent = parts.length ? `${parts.join(" · ")} · ${done ? "exportés" : "non exportés"}` : "Aucune mesure";
    $("#resultats-infos").classList.toggle("a-exporter", Boolean(measured.length) && !done);
    $("#resultats-vide").hidden = Boolean(list.length);
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
    showOverViewer(dialog);
  }

  // Choix de la photo sur la carte ---------------------------------------------------------

  map.on("click", (event) => {
    if (lineDraft !== null) addLinePoint(event.lngLat);
    else if (placing) placeOnMap(event.lngLat);
    else if (travelPick) pickTravelPoint(event.lngLat);
    else {
      // Mesure exportée de la couche sous le clic : revue sur sa photo ; sinon la photo la plus proche
      const { x, y } = event.point, layers = ["couche-traits", "couche-points"].filter((l) => map.getLayer(l));
      const hit = overlay && !measuring && layers.length ? map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers })
        .find((f) => overlay.features[f.id]?.properties.photo_ref) : null;
      if (hit) reviewMeasure(hit.id);
      else openNearest(event.lngLat.lng, event.lngLat.lat);
    }
  });

  // Relevé : « Placer sur la carte », puis un clic sur la carte pose l'objet là (sans visée) ; Échap annule
  let placing = false;
  function setPlacing(on) {
    placing = on;
    map.getCanvas().style.cursor = on ? "crosshair" : "";
    $("#placer-carte").textContent = on ? "Annuler (Échap)" : "📍 Placer sur la carte";
    $("#placer-carte").setAttribute("aria-pressed", String(on));
    if (on) setStatus("Relevé : cliquez sur la mini-carte l'emplacement de l'objet (zoomez pour être précis) ; Échap pour annuler.");
  }
  function placeOnMap(lngLat) {
    setPlacing(false);
    refresh(app.keep_map(lngLat.lng, lngLat.lat));
    editReleve(null, true);
  }
  $("#placer-carte").addEventListener("click", () => setPlacing(!placing));

  // Droite de mesure tracée sur la carte (ticket #28), avant la première visée du point A : un
  // premier clic pose le point de départ (pas un point de mesure), un trait suit la souris avec une
  // croix au bout, le second clic fixe l'orientation (en travers de la voie) ; Échap annule
  let lineDraft = null;  // pendant le tracé : point de départ (LngLat), ou false avant le premier clic
  const LINE_ID = "droite-tracee";
  const lineEnd = new maplibregl.Marker({ element: Object.assign(document.createElement("div"),
    { className: "croix-trace", textContent: "✛" }) });
  function showDrawnLine(ends) {  // [[lon, lat], [lon, lat]] sur la carte, ou null : retirée
    if (!map.isStyleLoaded()) return;
    const data = { type: "FeatureCollection", features: ends ? [{ type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: ends } }] : [] };
    if (map.getSource(LINE_ID)) map.getSource(LINE_ID).setData(data);
    else if (ends) {
      map.addSource(LINE_ID, { type: "geojson", data });
      map.addLayer({ id: LINE_ID, type: "line", source: LINE_ID, paint: { "line-color": "#0078ff", "line-width": 3 } });
    }
    if (ends) lineEnd.setLngLat(ends[1]).addTo(map);
    else lineEnd.remove();
  }
  function startLineDraft() {
    lineDraft = false;
    map.getCanvas().style.cursor = "crosshair";
    setStatus("Droite de mesure : cliquez sur la carte un point d'un côté de la voie, puis un second de l'autre "
      + "côté pour fixer son orientation. Zoomez pour être précis ; Échap pour annuler.");
    showModeOptions();
  }
  function endLineDraft() {
    lineDraft = null;
    map.getCanvas().style.cursor = "";
    showDrawnLine(null);
    showModeOptions();
  }
  function addLinePoint(lngLat) {
    if (lineDraft === false) {
      lineDraft = lngLat;
      showDrawnLine([[lngLat.lng, lngLat.lat], [lngLat.lng, lngLat.lat]]);
      return;
    }
    const start = lineDraft;
    endLineDraft();
    refresh(app.set_measure_line(start.lng, start.lat, lngLat.lng, lngLat.lat));
  }
  map.on("mousemove", (event) => {
    if (lineDraft) showDrawnLine([[lineDraft.lng, lineDraft.lat], [event.lngLat.lng, event.lngLat.lat]]);
  });
  function onLineEscape(event) {  // aussi dans la carte détachée (toggleMapWindow)
    if (event.key === "Escape" && lineDraft !== null) {
      endLineDraft();
      refresh();
    }
    if (event.key === "Escape" && placing) {
      setPlacing(false);
      refresh();
    }
    if (event.key === "Escape" && travelPick) setTravelPick(null);
  }
  document.addEventListener("keydown", onLineEscape);

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

  // Hors mesure, pointeur sur un objet de la couche : ce que font ses clics (attachViewer), une bulle de
  // chaque côté du pointeur (clic gauche à gauche), au style des étiquettes du bas de la visionneuse
  const objectTip = Object.assign(document.createElement("div"), { id: "bulle-objet", hidden: true });
  objectTip.append(Object.assign(document.createElement("p"), { className: "gauche", textContent: "Clic gauche : recaler le point" }),
    Object.assign(document.createElement("p"), { className: "droite", textContent: "Clic droit : fiche de l'objet" }));
  document.body.append(objectTip);
  // Affichées après 2 s de pointeur immobile sur l'objet ; tout mouvement les retire et relance l'attente
  let tipTimer = null;
  const hideTip = () => { clearTimeout(tipTimer); objectTip.hidden = true; };
  viewer.addEventListener("pointermove", (event) => {
    hideTip();
    if (measuring || !event.composedPath().some((el) => el.dataset?.objet !== undefined)) return;
    Object.assign(objectTip.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
    tipTimer = setTimeout(() => { objectTip.hidden = measuring; }, 2000);
  });
  for (const type of ["pointerleave", "pointerdown", "wheel"]) viewer.addEventListener(type, hideTip);

  // Clic droit dans la visionneuse en mesure : sélection d'un point, pas de menu du navigateur
  viewer.addEventListener("contextmenu", (event) => {
    // hors mesure, sur un objet de la couche : sa fiche (attachViewer), pas de menu non plus
    if (measuring || event.composedPath().some((el) => el.dataset?.objet !== undefined)) event.preventDefault();
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

  /** Nom de l'objet n° id de la couche dans sa fiche : sa colonne id (ou nom), sinon son rang. */
  function overlayObjectName(id) {
    const p = overlay.features[id].properties;
    return String(p.id ?? p.nom ?? id + 1);
  }

  /** Données de la fiche de l'objet n° id de la couche (voir buildFiche, ficheHtml) : ses attributs (sans
   * les colonnes techniques d'un relevé), sa position (premier sommet), la photo de son cadrage
   * automatique : celle de son recalage, sinon la photo affichée s'il y est dessiné, sinon la plus proche. */
  // own : sans la photo affichée (fiches de tous les objets : chacun sur sa photo, quelle que soit la photo affichée) ;
  // seq : la plus proche dans cette séquence seulement (sans recalage ni photo d'origine), à défaut la plus proche
  async function overlayFicheData(id, columns = null, own = false, seq = null) {
    const f = overlay.features[id];
    let [lon, lat] = f.geometry.coordinates;
    while (Array.isArray(lon)) [lon, lat] = lon;  // ligne, polygone : premier sommet
    const inSeq = seq && (await Carte.nearestPhoto(map, lon, lat, (p) => p.collection === seq && passesFilter(p)).catch(() => null))?.id;
    const pic = inSeq || f.properties.photo_ref || Object.keys(f.recalages || {})[0] || (overlayAt.has(id) && !own ? photo?.id : null)
      || (await Carte.nearestPhoto(map, lon, lat, passesFilter).catch(() => null))?.id || null;
    // Colonnes choisies, dans leur ordre (askFiche) ; texte ajouté après la valeur de l'étiquette repris ici
    const props = overlayProperties(f);
    const suffixes = Object.fromEntries(overlayLabels().filter((l) => l.column && l.suffix.trim()).reverse()
      .map((l) => [l.column, l.suffix.trim()]));  // même colonne aux deux : celui de la première
    const attributes = (columns || Object.keys(props).filter((c) => !(overlay.techniques || []).includes(c))).map((c) => {
      const text = Couche.format(props[c]);
      return [c, text && suffixes[c] ? `${text} ${suffixes[c]}` : text];
    });
    return { name: overlayObjectName(id), lon, lat, attributes, rows: [], texts: [], photo: pic, kind: null,
      bounds: [[lon, lat], [lon, lat]] };
  }

  /** Mesure exportée (App._records : vue_ref) revue sur sa photo : ses repères tels que dessinés quand elle a
   * été prise ([[cap, élévation]] en radians), ou null (autre photo, autre objet). */
  function overlayView(id) {
    const p = overlay.features[id]?.properties || {};
    if (!p.vue_ref || p.photo_ref !== photo?.id) return null;
    try {
      const view = JSON.parse(p.vue_ref);
      return Array.isArray(view) && view.length && view.every((v) => v.length === 2 && v.every(Number.isFinite)) ? view : null;
    } catch {
      return null;
    }
  }

  /** Repères d'une partie o de la couche (App.overlay_marks) dans la photo affichée : mesure exportée revue sur
   * sa photo telle que prise, sinon recalage dans cette photo compris ; { kind, pts: [[cap, élévation]] }. */
  function overlayPoints(o) {
    const view = overlayView(o.id);
    if (view) return { kind: view.length > 1 ? "ligne" : "point", pts: view };
    const [dyaw, dpitch] = overlay.features[o.id]?.recalages?.[photo?.id]?.decalage || [0, 0];
    return { kind: o.kind, pts: o.points.map(([yaw, pitch]) => [yaw + dyaw, pitch + dpitch]) };
  }

  /** Mesure exportée n° id de la couche revue : sa photo ouverte, cadrée sur elle comme la fiche. */
  async function reviewMeasure(id) {
    const pic = overlay.features[id]?.properties.photo_ref;
    if (!pic || measuring) return;
    try {
      if (photo?.id !== pic) await openPhotoReady(pic);
      frameView(overlayView(id));
    } catch (error) {
      notice(`Mesure : ${error.message}`);
    }
  }

  /** Repère de l'objet n° id de la couche dans la photo affichée, recalage compris : [[cap, élévation]], ou []. */
  function overlayEnds(id) {
    const view = overlayView(id);
    if (view) return view;
    const at = overlayAt.get(id);
    if (!at) return [];
    const [dyaw, dpitch] = overlay.features[id].recalages?.[photo?.id]?.decalage || [0, 0];
    return [[at.yaw + dyaw, at.pitch + dpitch]];
  }

  /** Objet id de la couche choisi pour être recalé dans la photo affichée. */
  function moveOverlayObject(id) {
    moving = { id, photo: photo.id };
    document.activeElement?.blur?.();  // un bouton cliqué avant (« Exporter »…) ne reçoit pas l'Entrée
    setStatus("Objet de la couche : cliquez sa place dans la photo, flèches pour l'ajuster, Entrée pour finir, "
      + "Suppr pour le remettre à sa place calculée. La carte n'est pas modifiée.");
    drawViewerMarks(currentMarks);
  }

  /** Objet en cours de recalage posé en (yaw, pitch) : sa pastille ou son étiquette y vient. */
  function placeOverlayObject(yaw, pitch) {
    const at = overlayAt.get(moving.id);
    if (!at) return;
    const dyaw = ((yaw - at.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;  // dans ]-π, π]
    setShift([dyaw, pitch - at.pitch]);
  }

  // Objets recalés sur une autre séquence de la même voie (photo recalée à moins de SAME_ROAD m), et
  // aucun sur celle-ci près d'ici : aller sur la photo recalée la plus proche ? Une fois par séquence
  // refusée. Sans photo affichée (couche importée) : la photo recalée la plus proche du centre de la carte.
  const SAME_ROAD = 30;
  const declinedSequences = new Set();
  function proposeRecaledPhoto() {
    if (!overlay || measuring || playing() || document.querySelector("dialog[open]")) return;
    const from = photo ? photo.geometry.coordinates : map.getCenter().toArray();
    const near = overlay.features.flatMap((f) => Object.entries(f.recalages || {}))
      .filter(([, r]) => r.position).map(([id, r]) => ({ id, ...r, d: metresBetween(r.position, from) }))
      .filter((r) => !photo || r.d < SAME_ROAD).sort((a, b) => a.d - b.d);
    const key = photo?.collection || "";
    if (!near.length || declinedSequences.has(key)
      || (photo && near.some((r) => r.id === photo.id || r.sequence === photo.collection))) return;
    const dialog = $("#alerte-recalage");
    dialog.querySelector("p").textContent = photo
      ? `Des objets de la couche ont été recalés sur une autre séquence de cette voie, à ${Math.round(near[0].d)} m. Aller sur cette photo ?`
      : "Des objets de la couche ont été recalés dans des photos. Ouvrir la plus proche ?";
    dialog.returnValue = "";
    dialog.addEventListener("close", async () => {
      if (dialog.returnValue !== "oui") return declinedSequences.add(key);
      try {
        const feature = await Carte.photoById(near[0].id);
        if (!feature) return notice("Photo recalée introuvable sur l'instance choisie (Filtre › Instance).");
        openPhoto(feature);
        map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
      } catch (error) {
        notice(`Photo recalée : recherche impossible (${error.message})`);
      }
    }, { once: true });
    showOverViewer(dialog);
  }

  /** Décalage de l'objet en recalage dans la photo affichée (null : retiré), gardé avec la couche. */
  function setShift(shift) {
    const f = overlay.features[moving.id];
    if (shift) {
      f.recalages = { ...f.recalages, [photo.id]: { decalage: shift, position: photo.geometry.coordinates.slice(0, 2),
        sequence: photo.collection } };
    }
    else if (f.recalages) {
      delete f.recalages[photo.id];
      if (!Object.keys(f.recalages).length) delete f.recalages;
    }
    setOverlayChanged(true);  // à réenregistrer dans le fichier
    saveOverlay();
    showOverlayInfo();
    drawViewerMarks(currentMarks);
  }

  // Objet en recalage : flèches de 0,05° (environ un pixel sans zoom), Entrée ou Échap : fini,
  // Suppr : remis à sa place calculée
  const SHIFT_STEP = 0.05 * Math.PI / 180;
  const SHIFT_KEYS = { ArrowLeft: [-SHIFT_STEP, 0], ArrowRight: [SHIFT_STEP, 0], ArrowUp: [0, SHIFT_STEP], ArrowDown: [0, -SHIFT_STEP] };
  function onOverlayKey(event) {
    const step = SHIFT_KEYS[event.key];
    if (movingId() === null || (!step && !["Enter", "Escape", "Delete"].includes(event.key))) return;
    if (event.target.closest?.("input, select, textarea")) return;  // les boutons, eux, n'y ont pas droit
    event.preventDefault();
    event.stopPropagation();
    if (step) {
      const [dyaw, dpitch] = overlay.features[moving.id].recalages?.[photo.id]?.decalage || [0, 0];
      return setShift([dyaw + step[0], dpitch + step[1]]);
    }
    if (event.key === "Delete") setShift(null);
    moving = null;
    setStatus("");
    drawViewerMarks(currentMarks);
  }
  document.addEventListener("keydown", onOverlayKey, true);

  // Ctrl+Z (⌘Z), comme le bouton « Effacer » : dernier geste de mesure annulé (visée, clic, mesure
  // en cours, dernier point) ; dans un champ de saisie, l'annulation du texte reste celle du navigateur
  // Ctrl+Y (Ctrl+Maj+Z, ⌘⇧Z) : rétablit ce que le dernier « Effacer » a retiré
  function onUndoKey(event) {
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !["z", "y"].includes(key)) return;
    if (!app || !measuring || event.target.closest?.("input, select, textarea")) return;
    event.preventDefault();
    refresh(key === "y" || event.shiftKey ? app.redo() : app.undo());
    proposeDistance();
  }
  document.addEventListener("keydown", onUndoKey);

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
    win.document.addEventListener("keydown", onNudgeKey, true);
    win.document.addEventListener("keydown", onUndoKey);
    win.document.addEventListener("keydown", onLineEscape);
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

  function openPhoto(feature, touring = false) {
    if (!touring) {  // autre photo demandée : fin du parcours
      tour = null;
      $("#parcours-orienter").hidden = true;
    }
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

  // Lecture de la séquence : la carte suit le tracé des photos image par image, environ une photo
  // en retard, à une vitesse qui ne change que progressivement (une animation par photo, coupée
  // par la suivante, la faisait avancer par à-coups). Saisie à la main pendant la lecture : elle
  // n'est plus suivie jusqu'à la lecture suivante. Lieu, PCRS et ortho-express attendent l'arrêt.
  const PLAYING_INTERVAL_MAX = 1500;  // ms : intervalle plus long (pause, photo lente) non compté
  const PLAYING_DETAILS_DELAY = 700;  // ms sans nouvelle photo avant de compléter ses détails
  const FOLLOW_SMOOTH = 600;  // ms : temps de réponse de la vitesse de la carte
  const FOLLOW_JUMP = 300;  // m de retard au-delà desquels la carte saute à la photo
  let lastPhotoAt = 0;
  let photoInterval = 0;  // ms : intervalle moyen entre les photos de la lecture (moyenne glissante)
  let detailsTimer = null;
  // Suivi de la lecture : path, positions [lon, lat] à parcourir (la première : centre de la
  // carte) ; speed en m/ms ; held : carte saisie à la main
  const follow = { path: [], speed: 0, last: 0, frame: 0, held: false };

  const metresBetween = Carte.metresBetween;

  function followPhoto(coords) {
    if (follow.held) return;
    if (!follow.frame) {
      follow.path = [map.getCenter().toArray()];
      follow.speed = 0;
      follow.last = 0;
      follow.frame = requestAnimationFrame(followFrame);
    }
    follow.path.push(coords);
    let behind = 0;
    for (let i = 1; i < follow.path.length; i++) behind += metresBetween(follow.path[i - 1], follow.path[i]);
    if (behind > FOLLOW_JUMP) {  // trop loin derrière (saut dans la séquence) : sur la photo
      follow.path = [coords];
      map.jumpTo({ center: coords });
    }
  }

  function followFrame(t) {
    follow.frame = 0;
    if (!playing() || follow.held) {
      stopFollow();
      return;
    }
    const dt = follow.last ? Math.min(t - follow.last, 100) : 0;
    follow.last = t;
    const path = follow.path;
    let remaining = 0;
    for (let i = 1; i < path.length; i++) remaining += metresBetween(path[i - 1], path[i]);
    const wanted = remaining / Math.max(photoInterval || 500, 100);  // une photo de retard
    follow.speed += (wanted - follow.speed) * Math.min(1, dt / FOLLOW_SMOOTH);
    let step = follow.speed * dt;
    while (step > 0 && path.length > 1) {
      const segment = metresBetween(path[0], path[1]);
      if (segment <= step) {
        step -= segment;
        path.shift();
      } else {
        const k = step / segment;
        path[0] = [path[0][0] + (path[1][0] - path[0][0]) * k, path[0][1] + (path[1][1] - path[0][1]) * k];
        step = 0;
      }
    }
    map.jumpTo({ center: path[0] });
    follow.frame = requestAnimationFrame(followFrame);
  }

  /** Fin du suivi (lecture arrêtée, carte saisie) : sauf saisie, la carte rejoint la photo. */
  function stopFollow() {
    cancelAnimationFrame(follow.frame);
    follow.frame = 0;
    follow.path = [];
    if (!follow.held && photo && $("#centrer").checked) {
      map.easeTo({ center: photo.geometry.coordinates, duration: 400 });
    }
  }

  map.on("dragstart", (event) => {  // carte saisie à la main pendant la lecture : plus suivie
    if (event.originalEvent && follow.frame) follow.held = true;
  });

  function setPhoto(feature, recenter) {
    photo = feature;
    store.set("photo", feature.id);  // rouverte à la prochaine visite (voir reopenPhoto)
    showFavorites();  // étoile de la nouvelle photo
    // En bas à droite de la visionneuse : « 2025 – producteur » (année de la prise de vue)
    const producer = photoProducer(feature);
    const taken = (feature.properties?.datetime || "").slice(0, 4);
    $("#producteur-photo").textContent = [taken, producer].filter(Boolean).join(" – ");
    $("#producteur-photo").hidden = !producer && !taken;
    const moving = playing();
    clearTimeout(detailsTimer);
    if (moving) detailsTimer = setTimeout(() => { if (photo === feature) photoDetails(feature); }, PLAYING_DETAILS_DELAY);
    else photoDetails(feature);
    const coords = feature.geometry.coordinates;
    Carte.showView(map, coords, viewHeading(), viewFov());
    const now = performance.now();
    if (recenter && $("#centrer").checked) {
      if (moving) {
        const interval = now - lastPhotoAt;
        if (interval < PLAYING_INTERVAL_MAX) photoInterval = photoInterval ? 0.7 * photoInterval + 0.3 * interval : interval;
        followPhoto(coords);
      } else {
        map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 17) });
      }
    }
    lastPhotoAt = now;
    showPhotoInfo(feature);
    $("#capture-hd").disabled = !Calcul.hasWorker();  // « Avec les mesures » : selon les mesures (drawViewerMarks)
    if (app) refresh(app.set_picture(JSON.stringify(feature)));
    proposeRecaledPhoto();
    updateProducers();
    checkFarFromMeasures(coords);
  }

  /** Détails de la photo tirés des services : lieu, PCRS, ortho-express de son année. */
  function photoDetails(feature) {
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
    if ($("#mode").value === "releve") return;  // relevé : on avance le long de la voie, objet après objet
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
    showOverViewer(dialog);
  }

  function showPhotoInfo(feature, message) {
    const section = $("#fiche");
    $("#photo-copier").disabled = !feature;
    if (!feature) {
      $("#photo-titre").textContent = "Aucune photo";
      $("#photo-infos").textContent = message || "";
      section.replaceChildren(Object.assign(document.createElement("p"), { className: "aide", textContent: "—" }));
      return;
    }
    const p = feature.properties || {};
    // En-tête : date de prise de vue, producteur et caméra
    const when = p.datetime ? new Date(p.datetime) : null;
    $("#photo-titre").textContent = when && !isNaN(when)
      ? when.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }) : "Date inconnue";
    $("#photo-infos").textContent = [photoProducer(feature), (p["pers:interior_orientation"] || {}).camera_model]
      .filter(Boolean).join(" · ");
    $("#photo-copier").onclick = () => copyText(feature.id, $("#photo-copier"));
    const accuracy = p["quality:horizontal_accuracy"];
    const rows = [
      ["Précision GPS annoncée", accuracy != null ? `${String(accuracy).replace(".", ",")} m` : "—"],
      ["Identifiant", feature.id],
    ];
    const dl = document.createElement("dl");
    for (const [label, value] of rows) {
      const dd = Object.assign(document.createElement("dd"), { textContent: value || "—" });
      if (label === "Précision GPS annoncée") {
        // À la suite : précision calculée (vérification RTK sur le sol LiDAR HD ou RGE ALTI), mise à
        // jour par refresh quand la vérification arrive
        const computed = Object.assign(document.createElement("span"), { className: "precision-calculee" });
        dd.append(" · calculée ", computed);
      }
      if (label === "Identifiant") dd.className = "identifiant";
      dl.append(Object.assign(document.createElement("dt"), { textContent: label }), dd);
    }
    section.replaceChildren(dl);
  }

  // Aller à une photo par son identifiant (ou un lien Panoramax qui le contient)
  $("#id-photo").addEventListener("input", () => {
    $("#aller-photo button").disabled = !$("#id-photo").value.trim();  // champ vide : sans effet
  });
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
        help.textContent = "Photo introuvable sur l'instance choisie (Filtre › Instance).";
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

  // Favoris : photos gardées dans le navigateur, nommées « hameau – commune – voie – PR – pont »
  function favorites() {
    try { return JSON.parse(store.get("favoris", "[]")) || []; } catch { return []; }
  }

  /** Nom d'un favori, commune et voie en gras (gardées à l'ajout ; favori plus ancien : la voie
   * reconnue à sa forme, la commune juste avant elle dans le nom « lieu-dit – commune – voie – PR – pont »). */
  const VOIE = /^(?:[ADNM]|RD|RN|VC)\s?\d|^(?:rue|route|chemin|avenue|boulevard|place|impasse|allée|quai|voie|véloroute)\b/i;
  function favoriteName(f) {
    const parts = f.name.split(" – ");
    const strong = new Set([f.commune, f.voie].filter(Boolean));
    if (!strong.size) {
      const k = parts.findIndex((p) => VOIE.test(p));
      if (k >= 0) [parts[k], parts[k - 1]].filter(Boolean).forEach((p) => strong.add(p));
    }
    return parts.flatMap((p, k) => [...(k ? [" – "] : []),
      strong.has(p) ? Object.assign(document.createElement("strong"), { textContent: p }) : p]);
  }

  function showFavorites() {
    $("#favoris ol").replaceChildren(...favorites().map((f) => {
      // photo affichée : entourée
      const li = Object.assign(document.createElement("li"), { className: photo?.id === f.id ? "actuelle" : "" });
      const go = Object.assign(document.createElement("button"), {
        type: "button", className: "aller-favori",
        title: photo?.id === f.id ? "Photo affichée" : `Aller à la photo ${f.id}`,
      });
      go.append(...favoriteName(f));
      go.addEventListener("click", async () => {
        try {
          const feature = await Carte.photoById(f.id);
          if (!feature) return notice("Photo du favori introuvable sur l'instance choisie (Filtre › Instance).");
          openPhoto(feature);
          map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
        } catch (error) {
          notice(`Favori : recherche impossible (${error.message})`);
        }
      });
      const remove = Object.assign(document.createElement("button"), {
        type: "button", className: "effacer-resultat", textContent: "×", title: "Retirer ce favori",
      });
      remove.setAttribute("aria-label", `Retirer le favori : ${f.name}`);
      remove.addEventListener("click", () => removeFavorite(f.id));
      li.append(go, remove);
      return li;
    }));
    $("#favoris-exporter").disabled = !favorites().length;
    $("#compte-favoris").textContent = favorites().length || "";
    const n = favorites().length;
    $("#favoris-infos").textContent = n ? `${n} photo${n > 1 ? "s" : ""} · gardée${n > 1 ? "s" : ""} dans ce navigateur` : "Aucune photo";
    // Étoile de la visionneuse : pleine si la photo affichée est en favori
    const on = Boolean(photo) && favorites().some((f) => f.id === photo.id);
    $("#ajouter-favori").disabled = !photo || on;  // déjà en favori : sans effet
    $("#ajouter-favori").classList.toggle("en-favori", on);  // étoile pleine
    $("#ajouter-favori").title = on ? "Photo déjà en favori (son étoile sur la photo la retire)" : "Ajouter cette photo aux favoris";
    Object.assign($("#etoile-favori"), { hidden: !photo,
      title: on ? "Retirer cette photo des favoris" : "Ajouter cette photo aux favoris" });
    $("#etoile-favori").setAttribute("aria-pressed", String(on));
  }

  function removeFavorite(id) {
    store.set("favoris", JSON.stringify(favorites().filter((x) => x.id !== id)));
    showFavorites();
  }

  $("#etoile-favori").addEventListener("click", () => {
    if (photo && favorites().some((f) => f.id === photo.id)) removeFavorite(photo.id);
    else addFavorite();
  });
  $("#ajouter-favori").addEventListener("click", () => addFavorite());
  // Export et import des favoris (autre poste, autre navigateur) : fichier JSON [{ id, name }]
  $("#favoris-exporter").addEventListener("click", () => download(JSON.stringify(favorites(), null, 1),
    "favoris-panoramax.json", "application/json"));
  // Couche importée (GeoJSON) : une à la fois, couleur et étiquette selon une colonne ; gardée avec
  // ses réglages dans le navigateur d'une session à l'autre, jusqu'à « Retirer »
  let overlay = null;  // { name, features (WGS 84, Couche.read), columns, crs }
  // Colonnes de contrôle d'un objet relevé, sans intérêt pour la couleur ou l'étiquette (nb_visees reste :
  // qualité de la triangulation)
  const RELEVE_TECHNIQUES = ["angle", "incert_m", "ecart_m", "dist_max_m", "gps_m", "photos", "date_mesure", "z_ngf"];
  // Recalage d'un objet de la couche dans la photo affichée, la carte n'en est pas touchée : décalage
  // en cap et élévation (radians), feature.recalages[identifiant de photo] (Couche.read), gardé avec la
  // couche et dans son export GeoJSON
  const overlayAt = new Map();  // objet → position sans décalage de sa pastille ou de son étiquette
  let moving = null;  // { id, photo } : objet en cours de recalage
  const movingId = () => (moving && !measuring && moving.photo === photo?.id ? moving.id : null);
  /** Clés des valeurs masquées de la colonne de couleur affichée (Couche.style : properties._cle). */
  function overlayMasked() {
    return new Set(overlay?.masques?.[$("#couche-couleur").value] || []);
  }
  const EYE_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
    + '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_SHUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
    + '<path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.5 6 10 6a9.6 9.6 0 004.4-1" stroke-linecap="round"/></svg>';

  /** Réglages des deux étiquettes de la photo : [{ column, titled, suffix }]. */
  const overlayLabels = () => ["", "2"].map((n) => ({ column: $(`#couche-etiquette${n}`).value,
    titled: $(`#couche-intitule${n}`).checked, suffix: $(`#couche-suffixe${n}`).value }));

  function showOverlayStyle() {
    if (!overlay) return;
    const column = $("#couche-couleur").value;
    const custom = overlay.couleurs[column] ||= {};
    for (const n of ["", "2"]) {  // sans étiquette, sans effet
      $(`#couche-intitule${n}`).disabled = $(`#couche-suffixe${n}`).disabled = !$(`#couche-etiquette${n}`).value;
    }
    const legend = Couche.style(overlay.features, column, overlayLabels(), custom, $("#couche-etiquette-carte").value);
    $("#couche-couleurs-defaut").disabled = !Object.keys(custom).length;
    if (legend.degrade && !custom.min && !custom.max) {
      setStatus("Dégradé : cliquez les pastilles « minimum » et « maximum » de la légende pour choisir ses couleurs.");
    }
    // Clic sur une pastille : palette en fenêtre flottante, la couleur choisie remplace la sienne
    const swatch = ({ cle, couleur, texte }) => {
      const button = Object.assign(document.createElement("button"), {
        type: "button", className: "pastille-couche", title: "Changer la couleur" });
      button.setAttribute("aria-label", `Couleur de « ${texte} »`);
      button.style.background = couleur;
      // popover : fermée par Échap, par un clic ailleurs ou au choix d'une couleur (liste redessinée)
      const palette = Object.assign(document.createElement("div"), { className: "palette-couche", popover: "auto" });
      palette.append(...Couche.CHOICES.map((c) => {
        const choice = Object.assign(document.createElement("button"), { type: "button", className: "pastille-couche" });
        choice.setAttribute("aria-label", c);
        choice.setAttribute("aria-pressed", String(c === couleur));
        choice.style.background = c;
        choice.addEventListener("click", () => {
          custom[cle] = c;
          showOverlayStyle();
          saveOverlay();
        });
        return choice;
      }));
      button.popoverTargetElement = palette;
      palette.addEventListener("beforetoggle", (event) => {
        if (event.newState !== "open") return;
        const r = button.getBoundingClientRect();
        Object.assign(palette.style, { left: `${Math.min(r.left, innerWidth - 290)}px`, top: `${r.bottom + 4}px` });  // ~280 px de large
      });
      palette.addEventListener("toggle", (event) => {  // trop bas (pastille en bas de l'écran) : au-dessus d'elle
        if (event.newState === "open" && palette.getBoundingClientRect().bottom > innerHeight - 8) {
          palette.style.top = `${Math.max(8, button.getBoundingClientRect().top - palette.offsetHeight - 4)}px`;
        }
      });
      return [button, palette];
    };
    // Œil par valeur (couleur selon une colonne) : ses objets masqués sur la carte et dans la photo
    const masked = overlayMasked();
    const item = (entry) => {
      const li = Object.assign(document.createElement("li"), { className: masked.has(entry.cle) ? "masquee" : "" });
      li.append(...swatch(entry), Object.assign(document.createElement("span"), { className: "texte-valeur", textContent: entry.texte }));
      if (column) {
        const shown = !masked.has(entry.cle);
        const eye = Object.assign(document.createElement("button"), { type: "button", className: "oeil-valeur",
          innerHTML: shown ? EYE_OPEN : EYE_SHUT, title: shown ? "Masquer ces objets" : "Afficher ces objets" });
        eye.setAttribute("aria-label", `${shown ? "Masquer" : "Afficher"} « ${entry.texte} »`);
        eye.setAttribute("aria-pressed", String(shown));
        eye.addEventListener("click", () => {
          const list = overlay.masques[column] ||= [];
          if (shown) list.push(entry.cle);
          else list.splice(list.indexOf(entry.cle), 1);
          showOverlayStyle();
          saveOverlay();
        });
        li.append(eye);
      }
      return li;
    };
    let items = legend.map(item);
    if (legend.degrade) {  // minimum, barre du dégradé, maximum ; valeurs dessous ; puis « vide »
      const [low, high, ...rest] = legend;
      const bar = Object.assign(document.createElement("li"), { className: "barre-degrade" });
      const ramp = document.createElement("span");
      ramp.style.background = `linear-gradient(90deg, ${low.couleur}, ${high.couleur})`;
      bar.append(...swatch(low), ramp, ...swatch(high));
      const ends = Object.assign(document.createElement("li"), { className: "bornes-degrade" });
      ends.append(...[low, high].map(({ texte }) => Object.assign(document.createElement("span"), { textContent: texte })));
      items = [bar, ends, ...rest.map(item)];
    }
    $("#titre-legende").textContent = legend.degrade ? "Dégradé" : "Légende";
    $("#couche-legende").classList.toggle("degrade", Boolean(legend.degrade));
    $("#couche-legende").replaceChildren(...items);
    // Œil de la couche fermé : ni sur la carte ni dans la photo, réglages gardés ; valeurs masquées retirées
    Carte.showOverlay(map, $("#couche-visible").checked ? { type: "FeatureCollection",
      features: overlay.features.filter((f) => !masked.has(f.properties._cle)) } : null);
    refresh();
  }

  /** Fiche de la couche : nombre d'objets, système de coordonnées, objets recalés dans des photos. */
  function showOverlayInfo() {
    const n = overlay.features.length, k = overlay.features.filter((f) => f.recalages).length;
    $("#couche-infos").textContent = [`${n} objet${n > 1 ? "s" : ""}`,
      overlay.crs === "lambert93" ? "Lambert 93 converti" : "WGS 84", k ? `${k} recalé${k > 1 ? "s" : ""}` : ""]
      .filter(Boolean).join(" · ");
    $("#couche-fiches").textContent = `Fiches PDF des ${n} objet${n > 1 ? "s" : ""}`;
    $("#couche-fiches").disabled = !n;
  }

  /** Couche en place (lue d'un fichier, ou gardée) : calcul, réglages, carte ; cadrée dessus si fit. */
  // mapLabel : colonne de l'étiquette de la mini-carte ; null : « id » (sans tenir compte de la casse), sinon la première
  function loadOverlay(name, read, color = "", label = "", fit = false, visible = true, colors = {}, masks = {}, mapLabel = null, label2 = "") {
    overlay = { name, ...read, couleurs: colors, masques: masks };  // masques : { colonne: [clés de légende masquées] }
    moving = null;  // couleurs choisies : { colonne: { clé de légende: couleur } }
    $("#couche-visible").checked = visible;
    const n = app.set_overlay(JSON.stringify(read.features.map(({ id, geometry }) => ({ id, geometry }))));
    // Relevé (envoyé, ou réimporté) : colonnes techniques hors des listes, gardées dans les exports
    const technical = RELEVE_TECHNIQUES.every((c) => read.columns.includes(c)) ? RELEVE_TECHNIQUES : [];
    const choices = read.columns.filter((c) => !technical.includes(c));
    overlay.techniques = technical;
    mapLabel ??= choices.find((c) => c.toLowerCase() === "id") ?? choices[0] ?? "";
    for (const [id, value] of [["#couche-couleur", color], ["#couche-etiquette", label], ["#couche-etiquette2", label2],
      ["#couche-etiquette-carte", mapLabel]]) {
      $(id).replaceChildren(new Option(id === "#couche-couleur" ? "couleur unique" : "aucune", ""),
        ...choices.map((c) => new Option(c, c)));
      $(id).value = choices.includes(value) ? value : "";
    }
    $("#couche-nom").textContent = name;
    showOverlayInfo();
    for (const id of ["#couche-accueil", "#couche-formats", "#couche-crs"]) $(id).hidden = true;
    $("#couche-reglages").hidden = false;
    $("#couche-retirer").disabled = false;
    $("#couche-exporter").disabled = false;
    $("#couche-csv").disabled = false;
    $("#couche-modele").disabled = Boolean(fieldsError(overlayFields()));
    showOverlayStyle();
    if (fit) {
      const xs = [], ys = [];
      (function walk(c) { if (typeof c[0] === "number") { xs.push(c[0]); ys.push(c[1]); } else c.forEach(walk); })(
        read.features.map((f) => f.geometry.coordinates));
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 30, maxZoom: 17 });
    }
    proposeRecaledPhoto();
    return n;
  }

  /** Couche et réglages gardés dans le navigateur ; faux si elle est trop grosse pour y tenir. */
  function saveOverlay() {
    if (!overlay) return true;
    const { name, features, columns, crs, couleurs, masques, fiche } = overlay;
    const text = JSON.stringify({ name, columns, crs, couleurs, masques, fiche, couleur: $("#couche-couleur").value, etiquette: $("#couche-etiquette").value,
      intitule: $("#couche-intitule").checked, suffixe: $("#couche-suffixe").value, etiquetteCarte: $("#couche-etiquette-carte").value,
      etiquette2: $("#couche-etiquette2").value, intitule2: $("#couche-intitule2").checked, suffixe2: $("#couche-suffixe2").value,
      modifie: Boolean(overlay.modifie), dateFichier: overlay.dateFichier ?? null,
      visible: $("#couche-visible").checked,
      features: features.map(({ type, id, geometry, properties, recalages }) => ({ type, id, geometry, recalages,
        properties: Object.fromEntries(Object.entries(properties).filter(([k]) => !k.startsWith("_"))) })) });
    store.set("couche", text);
    return store.get("couche") === text;
  }

  /** Couche gardée de la session précédente, remise une fois le calcul prêt (voir le démarrage). */
  function restoreOverlay() {
    let saved = null;
    try { saved = JSON.parse(store.get("couche") || "null"); } catch { /* illisible : aucune */ }
    $("#couche-intitule").checked = Boolean(saved?.intitule);
    $("#couche-suffixe").value = saved?.suffixe || "";
    $("#couche-intitule2").checked = Boolean(saved?.intitule2);
    $("#couche-suffixe2").value = saved?.suffixe2 || "";
    if (!saved?.features?.length) return;
    loadOverlay(saved.name, saved, saved.couleur, saved.etiquette, false, saved.visible !== false,
      saved.couleurs || {}, saved.masques || {}, saved.etiquetteCarte ?? null, saved.etiquette2 || "");
    setOverlayChanged(Boolean(saved.modifie));
    const kept = overlay;  // fichier de la couche (Chrome, Edge), relu de façon asynchrone
    fileStore("readonly", (s) => s.get("couche")).then((handle) => {
      if (overlay === kept && handle?.name === kept.name) kept.fichier = handle;
    }).catch(() => null);
  }

  // Chrome, Edge : fichier choisi avec sa poignée, pour y réenregistrer (« Enregistrer ») ; sinon, champ de fichier
  for (const id of ["#couche-importer", "#couche-remplacer"]) $(id).addEventListener("click", async () => {
    if (!window.showOpenFilePicker) return $("#couche-fichier").click();
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true, types: [{ description: "Couches (GeoJSON, Shapefile, GeoPackage)",
        accept: { "application/octet-stream": [".geojson", ".json", ".zip", ".shp", ".dbf", ".prj", ".cpg", ".shx", ".gpkg"] } }] });
    } catch (error) {
      if (error.name !== "AbortError") $("#couche-fichier").click();  // sélecteur refusé : champ de fichier
      return;
    }
    importOverlay(await Promise.all(handles.map((h) => h.getFile())), handles);
  });
  $("#mesures-importer").addEventListener("click", () => $("#couche-importer").click());  // même sélecteur de fichier
  $("#couche-fichier").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    importOverlay(files);
  });
  // Fichier glissé sur l'onglet Couche (avec son .dbf et son .prj pour un Shapefile)
  const layerTab = $("#couche");
  layerTab.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    layerTab.classList.add("survol");
  });
  layerTab.addEventListener("dragleave", (event) => {
    if (!layerTab.contains(event.relatedTarget)) layerTab.classList.remove("survol");
  });
  layerTab.addEventListener("drop", async (event) => {
    event.preventDefault();
    layerTab.classList.remove("survol");
    const files = [...event.dataTransfer.files];
    // Poignées demandées pendant l'événement (Chrome, Edge), lues ensuite
    const asked = [...event.dataTransfer.items].map((item) => item.getAsFileSystemHandle?.());
    importOverlay(files, (await Promise.all(asked.map((p) => p?.catch(() => null)))).filter(Boolean));
  });

  /** Couche lue des fichiers choisis ou glissés, remplaçant celle en place ; handles : leurs poignées (Chrome,
   * Edge), celle d'un GeoJSON seul gardée pour y réenregistrer. */
  async function importOverlay(files, handles = []) {
    if (!files.length || !app) return;
    try {
      setStatus("Lecture de la couche…");
      // GeoPackage de plusieurs tables : celle à afficher, par son numéro
      const choose = (names) => (names.length < 2 ? names[0]
        : names[Number(prompt(`Tables du GeoPackage :\n${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nNuméro de la table à afficher :`, "1")) - 1]);
      const { name, ...read } = await Couche.readFiles(files, choose);
      // Mesures exportées (App._records) : leur valeur en étiquette, la première revue sur sa photo
      const review = read.columns.includes("vue_ref") ? read.features.findIndex((f) => f.properties.photo_ref) : -1;
      const label = review >= 0 && read.columns.includes("etiquette") ? "etiquette" : "";
      const n = loadOverlay(name, read, "", label, true, true, {}, {}, label || null);
      setOverlayFile(handles.length === 1 && /\.(geo)?json$/i.test(handles[0].name) ? handles[0] : null, files[0].lastModified);
      setOverlayChanged(false);
      const kept = saveOverlay();
      setStatus(`Couche « ${name} » importée : ${n} partie${n > 1 ? "s" : ""} d'objets.`
        + (kept ? "" : " Trop grosse pour être gardée dans le navigateur : à réimporter à la prochaine ouverture.")
        + (review >= 0 ? " Cliquez une mesure sur la carte pour la revoir sur sa photo." : ""));
      if (review >= 0) reviewMeasure(review);
    } catch (error) {
      setStatus(`Couche non importée : ${error.message}`, "echec");
    }
  }
  for (const id of ["#couche-suffixe", "#couche-suffixe2"]) $(id).addEventListener("input", () => {  // à chaque lettre : étiquettes à jour en tapant
    showOverlayStyle();
    saveOverlay();
  });
  for (const id of ["#couche-couleur", "#couche-etiquette", "#couche-etiquette2", "#couche-etiquette-carte", "#couche-intitule",
    "#couche-intitule2", "#couche-visible"]) {
    $(id).addEventListener("change", () => {
      showOverlayStyle();
      saveOverlay();
    });
  }
  $("#couche-couleurs-defaut").addEventListener("click", () => {
    overlay.couleurs[$("#couche-couleur").value] = {};
    showOverlayStyle();
    saveOverlay();
  });
  const overlayProperties = (f) => Object.fromEntries(Object.entries(f.properties).filter(([k]) => !k.startsWith("_")));
  const overlayBaseName = () => overlay.name.replace(/\.(geojson|json|zip|shp|gpkg)\b.*$/i, "").replace(/[\\/:*?"<>|]/g, "-");
  /** La couche en GeoJSON (WGS 84), recalages dans les photos compris. */
  const overlayGeojson = () => JSON.stringify({ type: "FeatureCollection",
    features: overlay.features.map((f) => ({ type: "Feature", geometry: f.geometry, recalages: f.recalages, properties: overlayProperties(f) })) });
  /** Export GeoJSON avec les recalages, à importer sur un autre poste ; vrai si enregistré. */
  async function exportOverlay() {
    const content = overlayGeojson();
    try {
      return await download(content, `${overlayBaseName()}-recale.geojson`, "application/geo+json");
    } catch (error) {
      notice(`Couche non exportée : ${error.message}`);
      return false;
    }
  }
  $("#couche-exporter").addEventListener("click", exportOverlay);

  // « Enregistrer » : recalages réécrits dans le fichier importé (poignée gardée dans le navigateur, IndexedDB,
  // pour l'ouverture suivante) ; sans fichier modifiable (Firefox, Shapefile, GeoPackage, relevé), « Enregistrer
  // sous » en GeoJSON, puis ce fichier-là. Grisé tant que rien n'a changé depuis.
  const fileStore = (mode, write) => new Promise((resolve, reject) => {
    const open = indexedDB.open("web-measures", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("fichiers");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = write(open.result.transaction("fichiers", mode).objectStore("fichiers"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
  // date : dernière modification du fichier connue (import, enregistrement), pour voir s'il a changé depuis
  function setOverlayFile(handle, date = null) {
    overlay.fichier = handle;
    overlay.dateFichier = handle ? date : null;
    fileStore("readwrite", (s) => (handle ? s.put(handle, "couche") : s.delete("couche"))).catch(() => null);
  }
  function setOverlayChanged(changed) {
    overlay.modifie = changed;
    $("#couche-enregistrer").disabled = !changed;
  }
  async function saveOverlayFile() {
    const content = overlayGeojson();
    const write = async (handle) => {
      const out = await handle.createWritable();
      await out.write(content);
      await out.close();
    };
    try {
      const handle = overlay.fichier;
      if (handle) {
        // Autorisation d'écrire : demandée par le navigateur une fois par séance au plus
        const allowed = (await handle.queryPermission({ mode: "readwrite" })) === "granted"
          || (await handle.requestPermission({ mode: "readwrite" })) === "granted";
        // Fichier inchangé depuis l'import ou le dernier enregistrement : écrit sans rien demander ; changé
        // entre-temps (QGIS…) : écraser, l'enregistrer ailleurs, ou rien ; effacé ou déplacé : ailleurs
        const file = allowed ? await handle.getFile().catch((e) => (e.name === "NotFoundError" ? null : Promise.reject(e))) : null;
        if (allowed && !file) setStatus(`Fichier « ${handle.name} » introuvable (effacé ou déplacé) : choisissez où enregistrer la couche.`);
        const date = file?.lastModified;
        const choice = !file ? "sous" : overlay.dateFichier == null || date === overlay.dateFichier ? "ecraser"
          : await ask($("#fichier-change"), `Le fichier « ${handle.name} » a été modifié le ${new Date(date).toLocaleString("fr-FR")}, `
            + "après son import ou son dernier enregistrement ici. L'écraser avec la couche affichée ?");
        if (!choice) return;
        if (choice === "ecraser") {
          await write(handle);
          overlay.dateFichier = (await handle.getFile()).lastModified;
          setOverlayChanged(false);
          saveOverlay();
          return setStatus(`Couche enregistrée dans « ${handle.name} ».`);
        }
      }
      if (window.showSaveFilePicker) {
        const target = await window.showSaveFilePicker({ suggestedName: `${overlayBaseName()}.geojson`,
          types: [{ accept: { "application/geo+json": [".geojson"] } }] });
        await write(target);
        setOverlayFile(target, (await target.getFile()).lastModified);
        overlay.name = target.name;
        $("#couche-nom").textContent = target.name;
      } else if (!(await download(content, `${overlayBaseName()}.geojson`, "application/geo+json"))) return;
      setOverlayChanged(false);
      saveOverlay();
      setStatus(`Couche enregistrée${window.showSaveFilePicker ? ` dans « ${overlay.name} »` : ""}.`);
    } catch (error) {
      if (error.name !== "AbortError") notice(`Couche non enregistrée : ${error.message}`);
    }
  }
  $("#couche-enregistrer").addEventListener("click", saveOverlayFile);

  /** Question dans la fenêtre dialog (texte du paragraphe) : valeur du bouton choisi, "" si fermée sans choix. */
  function ask(dialog, text) {
    dialog.querySelector("p").textContent = text;
    dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
      showOverViewer(dialog);
    });
  }
  // Export CSV (tableur français : point-virgule, virgule décimale) : attributs, puis lon et lat pour une
  // couche de points, géométrie en WKT sinon (QGIS la relit)
  $("#couche-fiches").addEventListener("click", () => askFiche({ tous: true }));
  $("#couche-csv").addEventListener("click", () => {
    const cell = (v) => {
      if (v == null) return "";
      const text = typeof v === "boolean" ? (v ? "oui" : "non") : typeof v === "number" ? String(v).replace(".", ",")
        : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const points = overlay.features.every((f) => f.geometry.type === "Point");
    const rows = [[...overlay.columns, ...(points ? ["lon", "lat"] : ["wkt"])].map(cell).join(";"),
      ...overlay.features.map((f) => [...overlay.columns.map((c) => f.properties[c]),
        ...(points ? f.geometry.coordinates.slice(0, 2) : [wkt(f.geometry)])].map(cell).join(";"))];
    download("\ufeff" + rows.join("\n") + "\n", `${overlayBaseName()}.csv`, "text/csv");
  });
  /** Géométrie GeoJSON en WKT (2D). */
  function wkt({ type, coordinates }) {
    const pt = (p) => `${p[0]} ${p[1]}`, line = (l) => `(${l.map(pt).join(", ")})`, poly = (p) => `(${p.map(line).join(", ")})`;
    const body = { Point: () => `(${pt(coordinates)})`, LineString: () => line(coordinates), Polygon: () => poly(coordinates),
      MultiPoint: () => `(${coordinates.map((p) => `(${pt(p)})`).join(", ")})`, MultiLineString: () => poly(coordinates),
      MultiPolygon: () => `(${coordinates.map(poly).join(", ")})` }[type];
    return body ? `${type.toUpperCase()} ${body()}` : "";
  }
  $("#couche-retirer").addEventListener("click", () => {
    overlay = null;
    moving = null;
    store.set("couche", "");
    app?.set_overlay("[]");
    Carte.showOverlay(map, null);
    $("#couche-reglages").hidden = true;
    for (const id of ["#couche-accueil", "#couche-formats", "#couche-crs"]) $(id).hidden = false;
    $("#couche-retirer").disabled = true;
    $("#couche-exporter").disabled = true;
    $("#couche-csv").disabled = true;
    $("#couche-modele").disabled = true;
    $("#couche-enregistrer").disabled = true;
    $("#couche-fiches").disabled = true;
    fileStore("readwrite", (s) => s.delete("couche")).catch(() => null);
    refresh();
  });

  $("#favoris-importer").addEventListener("click", () => $("#favoris-fichier").click());
  $("#favoris-fichier").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    let read;
    try { read = JSON.parse(await file.text()); } catch { read = null; }
    if (!Array.isArray(read)) return notice("Fichier de favoris illisible.");
    const known = new Set(favorites().map((f) => f.id));
    const added = read  // fichier venu d'ailleurs : seulement des identifiants de photo et des noms courts
      .filter((f) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(f?.id) && !known.has(f.id) && known.add(f.id))
      .map((f) => ({ id: f.id.toLowerCase(), name: String(f.name || f.id).slice(0, 200),
        commune: String(f.commune || "").slice(0, 100), voie: String(f.voie || "").slice(0, 100) }));
    store.set("favoris", JSON.stringify([...favorites(), ...added]));
    showFavorites();
    notice(added.length ? `${added.length} favori${added.length > 1 ? "s" : ""} importé${added.length > 1 ? "s" : ""}.`
      : "Favoris importés : rien de nouveau.");
  });

  async function addFavorite() {
    const feature = photo;
    if (!feature || favorites().some((f) => f.id === feature.id)) return;
    const [lon, lat] = feature.geometry.coordinates;
    const { parts } = await Lieu.describe(lon, lat);
    // Pont : son nom affiché en haut à gauche de la visionneuse, sans la route déjà nommée
    const bridge = $("#chute").hidden ? "" : ($("#chute .pont")?.textContent || "").replace(/\s*\([^)]*\)$/, "");
    const name = [parts?.lieudit, parts?.commune, parts?.voie, parts?.pr, bridge].filter(Boolean).join(" – ")
      || `Photo du ${(feature.properties?.datetime || "").slice(0, 10)}`;
    store.set("favoris", JSON.stringify([...favorites().filter((f) => f.id !== feature.id),
      { id: feature.id, name, commune: parts?.commune || "", voie: parts?.voie || "" }]));  // commune et voie : en gras
    showFavorites();
  }
  showFavorites();

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
    const label = button.innerHTML, icon = Boolean(button.querySelector("svg"));  // bouton à icône : ✔ ou ✖ seul
    button.textContent = done ? (icon ? "✔" : "✔ Copié") : (icon ? "✖" : "Copie refusée");
    setTimeout(() => { button.innerHTML = label; }, 1500);
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

  /**
   * Largeur : réticule tenu sur la droite de mesure (tirets bleus) sous le pointeur, masqué pendant ce
   * temps, là où le bord se posera : seule la direction du clic compte, le bord est sur cette droite (ticket #18).
   * event null : repère retiré.
   */
  let slideKind = null;  // réticule affiché : "largeur", "hauteur" (trait jaune en travers), ou null
  let heightAxis = null;  // hauteur : [pied, sommet] de la 1re hauteur depuis A (App.height_axis), ou null

  /** Point de la droite de la vue passant par les directions a et c (grand cercle) le plus proche
   * de (yaw, pitch) ; même calcul que web_app._on_axis, qui contraint le clic. */
  function onAxis([a, c], yaw, pitch) {
    const vec = (y, p) => [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
    const [va, vc, v] = [vec(...a), vec(...c), vec(yaw, pitch)];
    const n = [va[1] * vc[2] - va[2] * vc[1], va[2] * vc[0] - va[0] * vc[2], va[0] * vc[1] - va[1] * vc[0]];
    const norm = Math.hypot(...n);
    if (norm < 1e-9) return { yaw, pitch };
    const d = (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / norm;
    const w = v.map((k, i) => k - d * n[i] / norm), length = Math.hypot(...w);
    return { yaw: Math.atan2(w[0], w[2]), pitch: Math.asin(Math.max(-1, Math.min(1, w[1] / length))) };
  }

  /** Croix sélectionnable (App.pick_points : celles du mode en cours) à CROSS_PX pixels au plus du point (x, y) de la
   * visionneuse : un clic là la sélectionne (App.click, on_cross). En pixels, quel que soit le zoom ; le calcul ne
   * connaît que des degrés. */
  const CROSS_PX = 12;
  let crossAt = [];  // croix sélectionnables (drawViewerMarks) : [[cap, élévation]]
  function nearCross(x, y) {
    const view = psv?.getPosition?.();
    if (!view) return false;
    return crossAt.some(([yaw, pitch]) => {
      const cos = Math.sin(pitch) * Math.sin(view.pitch) + Math.cos(pitch) * Math.cos(view.pitch) * Math.cos(yaw - view.yaw);
      if (cos <= 0.05) return false;  // derrière la vue
      const p = psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch });
      return Math.hypot(p.x - x, p.y - y) <= CROSS_PX;
    });
  }

  function slideOnGuide(event) {
    if (!psv) return;
    // Hauteur suivante depuis A : réticule sur l'axe de la première, sauf sur une croix (sélection)
    const box = event && psv.container.getBoundingClientRect();
    const onPhoto = event?.target?.closest?.(".psv-canvas-container, .psv-markers")
      && !event.target.closest(".psv-virtual-tour-link") && !nearCross(event.clientX - box.left, event.clientY - box.top);
    if (event && measuring && $("#mode").value === "height" && heightAxis && onPhoto) {
      const pointer = psv.dataHelper?.viewerCoordsToSphericalCoords?.({ x: event.clientX - box.left, y: event.clientY - box.top });
      if (pointer) {
        const position = onAxis(heightAxis, pointer.yaw, pointer.pitch);
        const [a, c] = heightAxis.map(([yaw, pitch]) => psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch }));
        showSlide(position, "hauteur", Math.atan2(c.y - a.y, c.x - a.x) * 180 / Math.PI + 90);
        return;
      }
    }
    // Seulement quand un clic poserait le bord (largeur pas encore faite, ou bord sélectionné à
    // recaler), et sur la photo : pas sur les boutons et flèches de la visionneuse
    const line = event && measuring && $("#mode").value === "road" && (!aiming || lineDrawn) && !edgeBAiming
      && (!newMeasure || pointSelected) && event.target?.closest?.(".psv-canvas-container, .psv-markers")
      && !event.target.closest(".psv-virtual-tour-link")
      && (pointSelected || !nearCross(event.clientX - box.left, event.clientY - box.top))  // sur une croix : sélection
      && currentMarks.find((m) => m.guide && !m.vertical && !m.epipolar);
    let position = null;
    if (line) {
      const yaw = psv.dataHelper?.viewerCoordsToSphericalCoords?.({ x: event.clientX - box.left, y: event.clientY - box.top })?.yaw;
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      for (let i = 1; yaw != null && i < line.points.length && !position; i++) {  // tronçon de la droite sous ce cap
        const [y0, p0] = line.points[i - 1], [y1, p1] = line.points[i];
        const span = wrap(y1 - y0), t = span ? wrap(yaw - y0) / span : -1;
        if (t >= 0 && t <= 1) position = { yaw: y0 + t * span, pitch: p0 + t * (p1 - p0) };
      }
    }
    showSlide(position, position && "largeur");
  }

  /** Réticule glissant à position (ou retiré si null) ; hauteur : trait jaune en travers de l'axe
   * (angle en degrés à l'écran), environ six fois la largeur du réticule. */
  function showSlide(position, kind, angle = 0) {
    if (position || slideKind) {  // dessiné en WebGL (Traits), comme les mesures ; couleur hors visée et calage
      Traits.attach(psv);
      Traits.setSlide(position && { at: [position.yaw, position.pitch], color: reticleColor(tilted, false, false),
        angle: kind === "hauteur" ? angle : null });
    }
    slideKind = position ? kind : null;
    psv.container.classList.toggle("sur-droite", !!position);
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
        // Hors mesure, clic sur un objet de la couche : à recaler ; puis clic : sa nouvelle place
        if (event?.type === "click" && !measuring && overlay && photo) {
          const id = event.data?.target?.closest?.("[data-objet]")?.dataset.objet;
          if (id !== undefined) {  // clic droit : sa fiche PDF ; clic : à recaler
            if (event.data.rightclick) askFiche({ objet: Number(id) });
            else moveOverlayObject(Number(id));
            return true;
          }
          if (movingId() !== null && !event.data?.rightclick) {
            placeOverlayObject(event.data.yaw, event.data.pitch);
            return true;
          }
        }
        if (event?.type === "click" && measuring && !onArrow(event)) {
          // croix sous le clic, en pixels (voir CROSS_PX) ; sans position dans la vue (clic simulé) : le calcul en juge
          const box = psv.container.getBoundingClientRect(), d = event.data;
          const [x, y] = [d.viewerX ?? d.clientX - box.left, d.viewerY ?? d.clientY - box.top];
          const inside = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= box.width && y <= box.height;
          const onCross = inside ? nearCross(x, y) : undefined;  // undefined : None en Python (null y serait jsnull)
          if (app && event.data?.rightclick) {  // clic droit : sélection d'un point à recaler
            refresh(photoReady() ? app.select_point(event.data.yaw, event.data.pitch, onCross) : LOADING);
          } else if (app) {
            if (photoReady()) remindZoom();
            refresh(photoReady() ? app.click(event.data.yaw, event.data.pitch, onCross) : LOADING);
          }
          return true;
        }
        return dispatch.call(this, event);
      };
      psv.container.addEventListener("pointermove", slideOnGuide);
      // Appui dans la photo : le bouton ou la liste qui avait le focus le perd (sinon les flèches et Entrée, destinées
      // au point sélectionné, changeraient le mode ou relanceraient le bouton : onNudgeKey les lui laisse)
      psv.container.addEventListener("pointerdown", (event) => {
        const active = document.activeElement;
        if (event.target.closest?.(".psv-canvas-container, .psv-markers") && active?.matches?.("input, select, textarea, button")) active.blur();
      });
      psv.container.addEventListener("pointerleave", () => slideOnGuide(null));
      attachPlayer();
      psv.addEventListener("position-updated", updateCursor);
      psv.addEventListener("zoom-updated", updateCursor);
      // Écartement des étiquettes : au zoom, et à l'arrêt d'une rotation (pendant, elles
      // tournent ensemble) ; pas à chaque image, qui forcerait une mise en page
      psv.addEventListener("position-updated", () => {
        clearTimeout(declutterTimer);
        declutterTimer = setTimeout(scheduleDeclutter, 150);
      });
      psv.addEventListener("zoom-updated", scheduleDeclutter);
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
  // mesure : on y change de photo par la carte. Si aucune adresse ne donne la liste : lecture 1x.
  const SPEEDS = [1, 2, 4, 8, 16];
  const WINDOW = 100;  // photos de la séquence lues d'un coup (environ 5 Ko chacune)
  let backward = false;  // sens de la dernière lecture, repris par « pause/reprise »
  let speed = 1;  // vitesse de la dernière lecture, reprise de même
  let fast = null;  // lecture rapide (2x à 16x) en cours : { collection, apis, rank, step, id, ids, points, timer }
  // Parcours (onglet « Vidéo ») en cours : voir travel ; endRank : rang de la photo d'arrivée dans la séquence lue
  // (null si elle n'y passe pas) ; best, bestAt : plus courte distance (m) à l'arrivée et son point ; axis : vue
  // dans l'axe du véhicule ; freeYaw : en regard libre, écart réglé à l'avant du véhicule
  let tour = null;
  let travelPick = null;  // 📍 de l'onglet « Vidéo » : point attendu sur la carte (« start », « end », « roll » : tonneau)
  // Endroits des tonneaux de la vidéo : { lonlat, marker } (repère bleu sur la carte ; un clic dessus le retire)
  let rollPoints = [];
  // Vues du dernier parcours (WebP réduits), pour son export en WebP animé ; tourTitle : son intitulé
  let tourViews = [], tourTitle = "";
  // Vidéo : parcours préparé (planPhotos : { photos, switches, dates, warning, title }), sa préparation ou son calcul en
  // cours ; videoReady : départ et arrivée connus (onglet « Vidéo »)
  let videoPlan = null, videoPreparing = false, videoRun = null, videoReady = false;
  const videoOk = Video.supported();
  const webpOk = Hyperlapse.supported();  // Safari n'encode pas le WebP
  const TOUR_AXIS = 4;  // rangs de part et d'autre de la photo pour l'axe et la pente (± 20 m)
  const TILES_WAIT = 4000;  // ms : attente au plus des tuiles HD d'une vue du parcours (réseau lent)
  const TOUR_REACH = 40;  // m : photos du départ et de l'arrivée cherchées à cette distance (même séquence)
  const TOUR_END = 30;  // m : hors de la séquence de l'arrivée, arrivée passée quand la distance remonte sous ce seuil
  const TOUR_AWAY = 40;  // m : séquence qui s'écarte d'autant de son point le plus proche de l'arrivée : rebranchement
  const TOUR_BRANCH = 25;  // m : séquences cherchées autour de ce point pour s'y rebrancher
  const TOUR_PASS = 10;  // m : séquences d'arrivée : celles qui y passent à moins de la plus proche + TOUR_PASS
  const TOUR_PATH = 100;  // rangs (500 m) du tracé des séquences d'arrivée lus de part et d'autre de l'arrivée
  const TOUR_JOIN = 10;  // m : photo lue sur le tracé d'une séquence d'arrivée à moins de cette distance
  const TOUR_LEAP = 30;  // m : écart au plus entre les deux photos d'une bifurcation (trajectoire lisse d'abord)
  const TOUR_TURN = 90;  // points (degrés de virage + mètres au-delà de 5 m) : saut au plus, hors du tracé quitté

  function playing() {
    return Boolean(fast) || Boolean(psv?.isSequencePlaying?.());
  }

  function stopPlayer() {
    if (fast) {
      clearTimeout(fast.timer);
      fast = null;
      updatePlayer();
      refresh();  // hauteur de chute d'un pont : calculée hors lecture
    }
    if (psv?.isSequencePlaying?.()) psv.stopSequence();
  }

  /** Adresses possibles de la séquence de la photo dans l'API de son instance, la plus sûre
   * d'abord : son lien « collection » (sauf celui du méta-catalogue), le lien « via » vers son
   * instance d'origine (fiche du méta-catalogue), puis l'adresse de ses images (juste pour les
   * instances qui les servent elles-mêmes : celles de l'IGN sont sur un stockage OVH, qui
   * refuse l'API). */
  function sequenceApis(feature) {
    const links = feature?.links || [];
    const out = [];
    const link = links.find((l) => l.rel === "collection")?.href || "";
    if (link && !link.startsWith(Carte.PANORAMAX_API)) out.push(link.replace(/\/$/, ""));
    const sites = [links.find((l) => l.rel === "via")?.href, feature?.assets?.sd?.href || feature?.assets?.hd?.href];
    for (const href of sites) {
      try {
        out.push(`${new URL(href).origin}/api/collections/${encodeURIComponent(feature.collection)}`);
      } catch { /* adresse absente ou illisible */ }
    }
    return [...new Set(out)];
  }

  function play(back, k) {
    stopPlayer();
    follow.held = false;  // nouvelle lecture : la carte suit de nouveau
    backward = back;
    speed = k;
    const rank = Number(photo?.properties?.["geovisio:rank_in_collection"]);
    const apis = photo?.collection ? sequenceApis(photo) : [];
    // Parcours en 1x : lecture pas à pas aussi (celle de la visionneuse coupe les tuiles HD et la vue dans l'axe)
    if ((k === 1 && !tour) || !Number.isInteger(rank) || !apis.length) {
      if (k !== 1) console.warn("Lecture rapide impossible (rang ou instance de la photo inconnus) : 1x");
      speed = 1;
      psv.playSequence(back);
      return;
    }
    fast = { collection: photo.collection, apis, rank, step: back ? -k : k, id: photo.id, ids: new Map(), points: new Map(),
      timer: null };
    updatePlayer();
    fastStep(fast);
  }

  /** Photos de la séquence autour du rang r, dans le sens de la lecture : rang -> identifiant.
   * Adresses de run.apis essayées dans l'ordre ; celle qui répond est gardée pour la suite. */
  async function loadRanks(run, r) {
    const start = run.step > 0 ? r - 1 : Math.max(0, r - WINDOW);
    let failure = null;
    while (run.apis.length) {
      try {
        const response = await fetch(`${run.apis[0]}/items?limit=${WINDOW}&startAfterRank=${start}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        for (const f of (await response.json()).features || []) {
          const rank = Number(f.properties?.["geovisio:rank_in_collection"]);
          if (!Number.isInteger(rank) || !f.id) continue;
          run.ids.set(rank, f.id);
          const exif = f.properties?.exif || {};
          const point = { coords: f.geometry?.coordinates, alt: exifNumber(exif["Exif.GPSInfo.GPSAltitude"]),
            heading: exifNumber(exif["Exif.GPSInfo.GPSImgDirection"]) ?? Number(f.properties?.["view:azimuth"]) };
          run.points.set(rank, { ...point, record: point.coords ? Video.record(f, point) : null });
        }
        return;
      } catch (error) {
        failure = error;
        if (run.ids.size) throw error;  // adresse qui a déjà répondu : panne passagère
        console.warn(`Lecture rapide : ${run.apis[0]} :`, error);
        run.apis.shift();  // adresse refusée : la suivante
      }
    }
    throw failure || new Error("aucune adresse de la séquence");
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
    if (!run.ids.size) {  // liste de la séquence introuvable : lecture 1x de la visionneuse
      stopPlayer();
      notice("Lecture rapide impossible ici (liste de la séquence introuvable) : lecture normale.");
      play(sign < 0, 1);
      return;
    }
    while (target !== run.rank && !run.ids.has(target)) target -= sign;  // fin de la séquence
    if (target === run.rank) {
      if (tour && tour.endRank == null) tourBranch(tour);  // parcours : une autre séquence vers l'arrivée
      else stopPlayer();
      return;
    }
    run.rank = target;
    run.id = run.ids.get(target);
    viewer.select(run.collection, run.id, true);
  }

  /** Attente des tuiles HD en cours de chargement (file de la visionneuse vide), TILES_WAIT ms au plus. */
  async function tilesLoaded(run) {
    const t0 = performance.now();
    while (run === fast && Object.keys(psv.adapter?.queue?.tasks || {}).length && performance.now() - t0 < TILES_WAIT) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Valeur EXIF « 31072/100 » ou « 310.72 » en nombre, ou null. */
  function exifNumber(text) {
    const [n, d = 1] = String(text ?? "").split("/").map(Number);
    return text != null && Number.isFinite(n / d) && d ? n / d : null;
  }

  const rankOf = (f) => Number(f.properties?.["geovisio:rank_in_collection"]);
  const angleBetween = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

  /**
   * Parcours du départ à l'arrivée ([lon, lat]) à la vitesse speed ; axis : vue dans l'axe du véhicule.
   * D'abord une séquence qui passe par les deux : lecture vers le rang de la photo d'arrivée (dans le sens
   * de la prise de vue de préférence : véhicules croisés à l'endroit). Sinon, la séquence qui part vers
   * l'arrivée, puis d'autres là où elle s'en écarte (tourBranch) : l'utilisateur en est prévenu au départ.
   */
  async function travel(start, end, title, speed, axis) {
    stopPlayer();
    tourViews = [];
    tourTitle = title || "";
    const plan = await tourPlan(start, end);
    if (plan.error) {
      setStatus(plan.error, "echec");
      notice(plan.error);
      return;
    }
    Object.assign(plan.t, { speed, axis });
    startTour(plan.t, plan.first, plan.back, plan.warning);
  }

  /**
   * Départ du parcours de start à end, commun à la lecture (travel) et à la vidéo (planPhotos) : séquences qui
   * passent à l'arrivée et leur tracé, photo de départ et sens. Rend { t, first, back, warning } (warning : pas de
   * séquence unique, le parcours en changera), ou { error } (texte).
   */
  async function tourPlan(start, end) {
    // Séquence qui passe à l'arrivée -> rang de sa photo la plus proche ; seulement celles qui passent à TOUR_PASS m
    // de la plus proche (une route voisine à 25 m ne passe pas à l'arrivée)
    const endRanks = new Map(), endPhotos = [];
    let closest = null;
    for (const f of await Carte.photosNear(map, ...end, passesFilter, TOUR_REACH).catch(() => [])) {
      if (endRanks.has(f.collection) || !Number.isInteger(rankOf(f))) continue;
      const d = metresBetween(f.geometry.coordinates, end);
      if (closest != null && d > closest + TOUR_PASS) continue;
      closest ??= d;
      endRanks.set(f.collection, rankOf(f));
      endPhotos.push(f);
    }
    // Tracé des séquences d'arrivée, TOUR_PATH rangs de part et d'autre de l'arrivée : bifurcation au carrefour (tourJoin)
    const paths = new Map();
    await Promise.all(endPhotos.map(async (f) => {
      const path = { apis: sequenceApis(f), step: 1, ids: new Map(), points: new Map() };
      const r = rankOf(f);
      try {
        await loadRanks(path, Math.max(0, r - TOUR_PATH + 1));
        await loadRanks(path, r + 1);
      } catch (error) {
        console.warn("Parcours : tracé de la séquence d'arrivée", f.collection, error);
      }
      if (path.points.size) paths.set(f.collection, path);
    }));
    const near = await Carte.photosNear(map, ...start, (f) => passesFilter(f) && Number.isInteger(rankOf(f)), TOUR_REACH)
      .catch(() => []);
    const t = { end, endRanks, paths, best: Infinity, bestAt: null, used: new Set(), switches: 0, dates: new Set() };
    const common = near.filter((f) => endRanks.has(f.collection) && rankOf(f) !== endRanks.get(f.collection));
    let first = common.find((f) => endRanks.get(f.collection) > rankOf(f)) || common[0];
    let back = first ? endRanks.get(first.collection) < rankOf(first) : null;
    if (!first) ({ feature: first, back } = towardEnd(near, end) || {});
    if (!first) {
      return { error: `Parcours impossible : aucune photo${filterActive() ? " retenue par le filtre" : ""} à moins de `
        + `${TOUR_REACH} m du départ ne part vers l'arrivée. Rapprochez le départ d'une route photographiée, ou changez le filtre.` };
    }
    return { t, first, back, warning: common.length ? "" : "Pas de séquence unique du départ à l'arrivée : le parcours "
      + "passera d'une séquence à l'autre, les photos peuvent différer (date, lumière, sens de prise de vue)." };
  }

  /** Parmi les photos `list` (les plus proches d'abord), la première dont la séquence va vers `end` :
   * { feature, back } (back : lecture à rebours), d'après le cap de la caméra (à 45° près de la direction
   * de l'arrivée, ou de son opposé à rebours) ; null sans photo qui convienne. */
  function towardEnd(list, end) {
    for (const f of list) {
      const azimuth = Number(f.properties?.["view:azimuth"]);
      if (!Number.isFinite(azimuth)) continue;
      const toEnd = Requeteur.bearing(f.geometry.coordinates, end);
      if (angleBetween(azimuth, toEnd) < 45) return { feature: f, back: false };
      if (angleBetween(azimuth + 180, toEnd) < 45) return { feature: f, back: true };
    }
    return null;
  }

  /**
   * Parcours t parti (ou reparti) de la photo first, à rebours si back : vue tournée vers l'avant du
   * véhicule (regard libre : l'écart réglé par l'utilisateur), puis lecture. Au départ, en regard libre
   * ou avec un avertissement (warning), le bandeau attend « ▶ Partir ».
   */
  function startTour(t, first, back, warning = "") {
    t.used.add(first.collection);
    t.dates.add((first.properties?.datetime || "").slice(0, 10));
    t.endRank = t.endRanks.get(first.collection) ?? null;
    t.back = back;
    openPhoto(first, true);
    tour = t;
    const t0 = Date.now();
    let asked = t0;
    const timer = setInterval(() => {  // lecture une fois la photo affichée
      if (tour !== t || Date.now() - t0 > 30000) {
        clearInterval(timer);
        return;
      }
      // Photo de la lecture précédente arrivée après la demande (rebranchement) : la nôtre redemandée
      // (comparée par identifiant : sa fiche est recréée au chargement)
      if (photo?.id !== first.id || !photoReady()) {
        if (Date.now() - asked > 3000) {
          asked = Date.now();
          openPhoto(first, true);
        }
        return;
      }
      clearInterval(timer);
      const ahead = back ? Math.PI : 0;  // avant du véhicule
      psv.rotate({ yaw: ahead + (t.freeYaw ?? 0), pitch: 0 });
      if ((t.axis || t.freeYaw != null) && !warning) {
        play(back, t.speed);
        return;
      }
      // Regard libre : la vue se règle d'abord sur la photo de départ ; avertissement : lu avant de partir
      $("#parcours-consigne").textContent = [warning, t.axis ? ""
        : "Regard libre : orientez la vue (glisser dans la photo), elle sera gardée tout le long."].filter(Boolean).join(" ");
      $("#parcours-orienter").hidden = false;
      $("#parcours-partir").onclick = () => {
        $("#parcours-orienter").hidden = true;
        if (tour !== t || photo?.id !== first.id) return;
        if (!t.axis) t.freeYaw = psv.getPosition().yaw - ahead;
        play(back, t.speed);
      };
    }, 200);
  }

  /**
   * Parcours sans séquence jusqu'à l'arrivée : celle lue s'en écarte, ou finit. Rebranchement là où elle en
   * est passée au plus près (t.bestAt) sur une autre séquence (pas déjà lue) qui va vers l'arrivée : une
   * qui y passe d'abord, sinon d'après le cap de la caméra. Sans elle, parcours arrêté.
   */
  async function tourBranch(t) {
    stopPlayer();  // lecture en cours arrêtée ; le parcours reste
    if (t.bestViews != null) tourViews.length = Math.min(tourViews.length, t.bestViews);  // export sans l'écart
    const next = await branchTarget(t);
    if (tour !== t) return;  // parcours quitté entre-temps
    if (!next) {
      tour = null;
      updatePlayer();
      setStatus(branchFailure(t), "echec");
      notice(branchFailure(t));
      return;
    }
    t.switches++;
    t.best = Infinity;
    t.bestAt = null;
    startTour(t, next.feature, next.back);
  }

  /** Séquence de rebranchement du parcours t, là où la séquence lue est passée au plus près de l'arrivée (t.bestAt),
   * pas déjà lue : une qui passe à l'arrivée d'abord, sinon d'après le cap de la caméra ; { feature, back } ou null. */
  async function branchTarget(t) {
    const list = t.bestAt ? await Carte.photosNear(map, ...t.bestAt,
      (f) => passesFilter(f) && !t.used.has(f.collection) && Number.isInteger(rankOf(f)), TOUR_BRANCH).catch(() => []) : [];
    const viaEnd = list.find((f) => t.endRanks.has(f.collection) && t.endRanks.get(f.collection) !== rankOf(f));
    return viaEnd ? { feature: viaEnd, back: t.endRanks.get(viaEnd.collection) < rankOf(viaEnd) } : towardEnd(list, t.end);
  }

  const branchFailure = (t) => `Parcours arrêté à ${Math.round(t.best)} m de l'arrivée : aucune séquence`
    + `${filterActive() ? " retenue par le filtre" : ""} ne continue vers elle depuis ici.`;

  /**
   * Décision du parcours t à la photo here (rang run.rank), commune à la lecture et à la vidéo : { action, join,
   * closer } ; action : "arrived" (rang de la photo d'arrivée atteint ou passé ; hors de sa séquence, à moins de
   * TOUR_END m quand la distance remonte), "join" (saut join sur une séquence d'arrivée, joinTarget), "branch"
   * (séquence qui s'écarte de TOUR_AWAY m de son point le plus proche de l'arrivée) ou null ; closer : plus près de
   * l'arrivée que jamais (t.best, t.bestAt mis à jour).
   */
  function tourDecide(t, run, here) {
    const sign = Math.sign(run.step);
    const d = here?.coords ? metresBetween(here.coords, t.end) : Infinity;
    if (t.endRank != null ? (run.rank - t.endRank) * sign >= 0 : t.best < TOUR_END && d > t.best) return { action: "arrived" };
    const closer = d < t.best;
    if (closer) {
      t.best = d;
      t.bestAt = here.coords;
    }
    if (t.endRank == null) {
      const join = joinTarget(t, run, here);
      if (join) return { action: "join", join, closer };
      if (d > t.best + TOUR_AWAY) return { action: "branch", closer };
    }
    return { action: null, closer };
  }

  /**
   * Parcours, photo affichée : vue dans l'axe du véhicule, c'est-à-dire tournée du biais de montage
   * de la caméra (médiane, sur les photos lues, de l'écart entre le cap de la trajectoire sur
   * ± 20 m et le cap EXIF au centième) : elle suit ainsi les virages et les carrefours. Vue abaissée
   * de la pente de la route (altitudes GPS des photos sur ± 20 m) : les panoramas ne sont pas mis à
   * niveau, la caméra penche avec le véhicule ; l'horizon reste ainsi en place. Le roulis (dévers)
   * n'est pas corrigé. Arrivée et rebranchement sur une autre séquence : voir la fin.
   */
  function tourStep(run) {
    const sign = Math.sign(run.step);
    const near = (rank, k) => {
      for (let i = TOUR_AXIS; i > 0; i--) if (run.points.get(rank + k * i)?.coords) return run.points.get(rank + k * i);
      return run.points.get(rank);
    };
    const offsets = [];
    for (const [rank, p] of run.points) {
      const a = near(rank, -1), b = near(rank, 1);
      if (p.coords && a !== b && Number.isFinite(p.heading)) {
        offsets.push(((Requeteur.bearing(a.coords, b.coords) - p.heading) % 360 + 540) % 360 - 180);
      }
    }
    offsets.sort((x, y) => x - y);
    const here = run.points.get(run.rank);
    const before = near(run.rank, -sign), after = near(run.rank, sign);
    if (tour.axis && here?.coords && offsets.length) {
      const d = metresBetween(before.coords, after.coords);
      const slope = before.alt != null && after.alt != null && d > 1 ? (after.alt - before.alt) / d : 0;
      const yaw = offsets[offsets.length >> 1] + (sign < 0 ? 180 : 0);  // lecture à rebours : vers l'arrière de la caméra
      psv.rotate({ yaw: yaw * Math.PI / 180, pitch: -Math.atan(slope) });
    }
    const decision = tourDecide(tour, run, here);
    if (decision.closer) tour.bestViews = tourViews.length + 1;  // vues gardées jusqu'à celle-ci (prise ensuite) comprise
    if (decision.action === "arrived") {
      const t = tour;
      tour = null;
      stopPlayer();
      notice(t.switches ? `Parcours terminé : arrivée atteinte, ${t.switches + 1} séquences (${[...t.dates].sort().join(", ")}).`
        : "Parcours terminé : arrivée atteinte.");
      return false;
    }
    if (decision.action === "join") tourJoin(tour, decision.join);
    if (decision.action === "branch") tourBranch(tour);
    return !decision.action;
  }

  /** Photo des tracés d'arrivée (t.paths) à moins de TOUR_JOIN m de coords, la plus près de l'arrivée en rangs
   * (puis en mètres) : { collection, rank, left (rangs jusqu'à l'arrivée), d } ; null sans photo assez proche. */
  function nearestOnPaths(t, coords) {
    let best = null;
    for (const [collection, path] of t.paths) {
      const endRank = t.endRanks.get(collection);
      for (const [rank, p] of path.points) {
        const d = p.coords ? metresBetween(p.coords, coords) : Infinity;
        const left = Math.abs(rank - endRank);
        if (d < TOUR_JOIN && (!best || left < best.left || (left === best.left && d < best.d))) best = { collection, rank, left, d };
      }
    }
    return best;
  }

  /**
   * Saut depuis le point from (cap heading) sur un tracé d'arrivée : photo à TOUR_LEAP m au plus (pas à moins d'un
   * demi-pas : même endroit) qui prolonge le mieux la trajectoire : moindre somme des virages (vers elle, puis vers sa
   * suivante en allant à l'arrivée), plus 1 point par mètre au-delà d'un pas de 5 m (écart plus grand accepté plutôt
   * qu'un crochet). Rend { collection, rank, score, sign } (sign : sens de lecture), score Infinity sans photo.
   */
  function leap(t, from, heading) {
    let best = { score: Infinity };
    for (const [collection, path] of t.paths) {
      const endRank = t.endRanks.get(collection);
      for (const [rank, p] of path.points) {
        const d = p.coords ? metresBetween(from, p.coords) : Infinity;
        if (d > TOUR_LEAP || d < 2.5) continue;
        const sign = Math.sign(endRank - rank);
        const go = Requeteur.bearing(from, p.coords);
        const after = sign ? path.points.get(rank + sign)?.coords : null;
        const turn = (Number.isFinite(heading) ? angleBetween(heading, go) : 0) + (after ? angleBetween(go, Requeteur.bearing(p.coords, after)) : 0);
        const score = turn + Math.max(0, d - 5);
        if (score < best.score) best = { collection, rank, score, sign };
      }
    }
    return best;
  }

  /**
   * Parcours hors d'une séquence d'arrivée : bifurcation sur l'une d'elles dès que son tracé passe à TOUR_LEAP m, au
   * saut le plus lisse (leap), quand la photo suivante n'en offre pas de meilleur : la trajectoire garde ainsi sa ligne
   * au carrefour, quitte à un écart plus grand que le pas de la séquence. Rien tant que la séquence lue suit ce tracé
   * vers l'arrivée (à TOUR_JOIN m), ni pour un saut à plus de TOUR_TURN points sauf là où elle le quitte. Rend le saut
   * { collection, rank, sign } ou null.
   */
  function joinTarget(t, run, here) {
    if (!t.paths?.size || !here?.coords) return null;
    const next = run.points.get(run.rank + run.step);
    if (!next?.coords && run.ids.has(run.rank + run.step)) return null;  // suivante sans position : décidé plus loin
    const at = nearestOnPaths(t, here.coords);
    const then = next?.coords ? nearestOnPaths(t, next.coords) : null;
    if (at && then && then.left < at.left) return null;  // tracé suivi vers l'arrivée
    const prev = run.points.get(run.rank - run.step)?.coords;
    const heading = prev ? Requeteur.bearing(prev, here.coords) : here.heading + (run.step < 0 ? 180 : 0);
    const jump = leap(t, here.coords, heading);
    if (jump.score === Infinity || (jump.score > TOUR_TURN && !at)) return null;
    if (next?.coords && leap(t, next.coords, Requeteur.bearing(here.coords, next.coords)).score < jump.score) return null;
    return jump;
  }

  /** Lecture : bifurcation du parcours t par le saut jump (joinTarget), sur la photo de la séquence d'arrivée. */
  function tourJoin(t, jump) {
    const { rank, sign } = jump;
    const path = t.paths.get(jump.collection);
    const t0 = tour;
    stopPlayer();
    Carte.photoById(path.ids.get(rank)).then((feature) => {
      if (tour !== t0) return;
      if (!feature) {
        tourBranch(t);
        return;
      }
      t.switches++;
      t.best = Infinity;
      t.bestAt = null;
      startTour(t, feature, sign < 0);
    }).catch(() => { if (tour === t0) tourBranch(t); });
  }

  /**
   * Photos du parcours de start à end pour la vidéo, sans la visionneuse : mêmes décisions que la lecture (tourPlan,
   * tourDecide, branchTarget), rang après rang (toutes les photos des séquences parcourues). Rend { photos
   * [Video.record], switches, dates, warning } ; erreur (texte) si le parcours est impossible.
   */
  async function planPhotos(start, end) {
    const plan = await tourPlan(start, end);
    if (plan.error) throw new Error(plan.error);
    const { t } = plan;
    const photos = [];
    let run = null, bestIndex = 0;
    const begin = (collection, apis, rank, sign, ids = new Map(), points = new Map()) => {
      t.used.add(collection);
      t.endRank = t.endRanks.get(collection) ?? null;
      t.best = Infinity;
      t.bestAt = null;
      run = { apis, step: sign, rank, ids, points };
    };
    begin(plan.first.collection, sequenceApis(plan.first), rankOf(plan.first), plan.back ? -1 : 1);
    // Rang suivant présent dans la séquence (rangs manquants sautés), ou null en fin de séquence
    const following = () => {
      for (let k = 1; k <= WINDOW; k++) if (run.ids.has(run.rank + k * run.step)) return run.rank + k * run.step;
      return null;
    };
    for (let guard = 0; guard < 100000; guard++) {
      if (!run.ids.has(run.rank) || following() == null) await loadRanks(run, run.rank);
      const here = run.points.get(run.rank);
      if (here?.record) {
        photos.push(here.record);
        t.dates.add(here.record.date);
      }
      const decision = tourDecide(t, run, here);
      if (decision.closer) bestIndex = photos.length;
      const done = () => ({ photos, switches: t.switches, dates: [...t.dates].filter(Boolean).sort(), warning: plan.warning });
      if (decision.action === "arrived") return done();
      if (decision.action === "join") {
        const { collection, rank, sign } = decision.join;
        const path = t.paths.get(collection);
        t.switches++;
        begin(collection, path.apis, rank, sign < 0 ? -1 : 1, path.ids, path.points);
        continue;
      }
      const next = following();
      if (decision.action === "branch" || (next == null && t.endRank == null)) {
        photos.length = Math.min(photos.length, bestIndex);  // sans l'écart
        const target = await branchTarget(t);
        if (!target) throw new Error(branchFailure(t));
        t.switches++;
        begin(target.feature.collection, sequenceApis(target.feature), rankOf(target.feature), target.back ? -1 : 1);
        continue;
      }
      if (next == null) return done();  // séquence d'arrivée finie avant sa photo d'arrivée
      run.rank = next;
    }
    throw new Error("parcours trop long");
  }

  // Onglet « Vidéo » : « ▶ Parcourir » grisé tant que la route ou un PR manque
  const travelPane = $("#parcours");
  const travelFields = Requeteur.travelForm(travelPane.querySelector(".champs-route"), map);
  const updateTravel = () => {
    $("#parcours-lancer").disabled = !travelFields.ready();
    videoReady = travelFields.ready();
    updatePlayer();
  };
  // Départ ou arrivée changés : vidéo à préparer de nouveau (pas les listes de la vidéo, qui ne changent pas le parcours)
  travelPane.querySelector(".champs-route").addEventListener("input", () => { videoPlan = null; });
  travelPane.addEventListener("input", updateTravel);
  travelPane.addEventListener("click", () => setTimeout(updateTravel));  // PR choisi dans une liste
  // 📍 : le prochain clic sur la mini-carte pose le départ ou l'arrivée (« start », « end ») ; Échap annule
  function setTravelPick(which) {
    travelPick = which;
    map.getCanvas().style.cursor = which ? "crosshair" : "";
    for (const button of travelPane.querySelectorAll(".sur-carte")) {
      button.setAttribute("aria-pressed", String(button.dataset.cote === which));
    }
    if (which) {
      setStatus(`Parcours : cliquez sur la mini-carte ${{ start: "le départ", end: "l'arrivée", roll: "l'endroit du tonneau" }[which]} ; `
        + "Échap pour annuler.");
    }
  }
  async function pickTravelPoint(lngLat) {
    const which = travelPick;
    setTravelPick(null);
    if (which === "roll") {  // tonneau : endroit ajouté, interrupteur activé ; le parcours ne change pas
      const lonlat = [lngLat.lng, lngLat.lat];
      const element = Object.assign(document.createElement("div"), { className: "repere-requete tonneau",
        title: "Tonneau de la vidéo (clic : le retirer)" });
      const point = { lonlat, marker: new maplibregl.Marker({ element, anchor: "bottom" }).setLngLat(lonlat).addTo(map) };
      element.addEventListener("click", (event) => {
        event.stopPropagation();  // pas un clic sur la carte
        point.marker.remove();
        rollPoints = rollPoints.filter((p) => p !== point);
        if (!rollPoints.length) $("#video-tonneau").checked = false;
        setStatus(`Tonneau retiré ; ${rollPoints.length || "aucun"} tonneau${rollPoints.length > 1 ? "x" : ""} restant${rollPoints.length > 1 ? "s" : ""}.`);
      });
      rollPoints.push(point);
      $("#video-tonneau").checked = true;
      setStatus(`Tonneau placé (${rollPoints.length} en tout ; sens alterné dans l'ordre du parcours, à moins de 30 m de `
        + "lui) ; 📍 pour en ajouter un, clic sur un repère bleu pour le retirer.");
      return;
    }
    await travelFields.pick(which, [lngLat.lng, lngLat.lat]);
    videoPlan = null;
    updateTravel();
  }
  for (const button of travelPane.querySelectorAll(".sur-carte")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();  // 📍 du tonneau : dans la ligne de l'interrupteur, sans le basculer
      setTravelPick(travelPick === button.dataset.cote ? null : button.dataset.cote);
    });
  }
  // Vitesse de regard affichée à côté de sa réglette ; elle change la durée de la vidéo
  $("#regard-vitesse").addEventListener("input", () => {
    $("#regard-valeur").textContent = `${$("#regard-vitesse").value} km/h`;
    updatePlayer();
  });
  // Durée du tonneau affichée à côté de sa réglette
  $("#tonneau-duree").addEventListener("input", () => {
    $("#tonneau-valeur").textContent = `${String($("#tonneau-duree").value).replace(".", ",")} s`;
  });
  // Tonneau activé sans endroit : le choisir sur la carte
  $("#video-tonneau").addEventListener("change", () => {
    if ($("#video-tonneau").checked && !rollPoints.length) setTravelPick("roll");
  });
  $("#parcours-lancer").addEventListener("click", async () => {
    const button = $("#parcours-lancer");
    button.disabled = true;
    try {
      const found = await travelFields.go();
      if (!found) return;
      map.fitBounds([found.start, found.end].reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds()),
        { padding: 60, maxZoom: 18 });
      await new Promise((resolve) => map.once("moveend", resolve));
      travel(found.start, found.end, found.title, Number($("#parcours-vitesse").value),
        $("#parcours-regard").value === "axe");
    } catch (error) {
      notice(`Parcours impossible : ${error.message}`);
    } finally {
      updateTravel();
    }
  });
  $("#parcours-export").addEventListener("click", async () => {
    const save = await saveAs(`parcours ${tourTitle || "Panoramax"}.webp`.replace(/[\\/:*?"<>|→]/g, "-"), "image/webp");
    if (!save) return;
    $("#parcours-export").disabled = true;
    try {
      await save(await Hyperlapse.webp(tourViews));
    } catch (error) {
      notice(`Export du parcours impossible : ${error.message}`);
    }
    updatePlayer();
  });

  // Vidéo MP4 du parcours, sans le lire dans la visionneuse, en deux clics : « Préparer » cherche ses photos
  // (planPhotos) et prévient d'un changement de séquence ; « Enregistrer » demande le fichier (la boîte ne s'ouvre que
  // juste après un clic), puis calcule la vidéo image par image
  $("#parcours-video").addEventListener("click", async () => {
    if (!videoPlan) {
      videoPreparing = true;
      updatePlayer();
      setStatus("Vidéo : recherche des photos du parcours…");
      try {
        const found = await travelFields.go();
        if (!found) throw new Error("départ ou arrivée introuvable");
        videoPlan = { ...await planPhotos(found.start, found.end), title: found.title };
        setStatus("Vidéo : PR des photos…");
        await prOfPhotos(videoPlan.photos, found.title.split(" ")[0]);
        // Carrefours du parcours (regard aux croisements) : tronçons de la BD TOPO, mailles en cache
        videoPlan.junctions = await Lieu.junctions(videoPlan.photos.map((p) => p.coords)).catch(() => []);
        setStatus(videoPlan.switches ? `Vidéo prête à enregistrer. ${videoWarning()}` : "Vidéo prête à enregistrer.",
          videoPlan.switches ? "avertissement" : "");
      } catch (error) {
        setStatus(`Vidéo impossible : ${error.message}`, "echec");
        notice(`Vidéo impossible : ${error.message}`);
      } finally {
        videoPreparing = false;
        updatePlayer();
      }
      return;
    }
    const save = await saveAs(`parcours ${videoPlan.title || "Panoramax"} ${$("#video-vitesse").value} km-h.mp4`
      .replace(/[\\/:*?"<>|→]/g, "-"), "video/mp4");
    if (!save) return;
    videoRun = new AbortController();
    updatePlayer();
    const t0 = Date.now();
    try {
      // Avancement aussi dans la ligne d'état : le fichier n'est écrit qu'à la fin du calcul (plusieurs minutes)
      const blob = await Video.mp4(videoPhotos(), Number($("#video-vitesse").value), (done, total) => {
        // Largeur fixe (chiffres de même largeur, espaces de la largeur d'un chiffre) : le texte ne saute pas
        const pad = (n, width) => String(n).padStart(width, "\u2007");
        const width = Math.max(5, String(total).length);  // place pour une longue vidéo (99 999 images, 55 min)
        const text = `Calcul de la vidéo en cours : image ${pad(done, width)} / ${pad(total, width)} `
          + `(${pad(Math.round(100 * done / total), 3)} %)`;
        $("#video-info").textContent = text;
        setStatus(text, "avancement");
        $("#statut").style.setProperty("--avancement", `${(100 * done / total).toFixed(1)}%`);
      }, videoRun.signal, { blur: $("#video-flou").checked, exposure: $("#video-expo").checked, ramp: $("#video-rampe").checked,
        counter: $("#video-compteur").checked, whip: $("#video-pano").checked,
        junctions: $("#video-regard").checked ? videoPlan.junctions : [],
        rolls: $("#video-tonneau").checked ? rollPoints.map((p) => p.lonlat) : [], rollTime: Number($("#tonneau-duree").value),
        lookSpeed: Number($("#regard-vitesse").value),
        title: $("#video-titre").checked ? { text: videoPlan.title.replace(/\+0*(\d)/g, "+$1"),
          sub: `Photos du ${videoPlan.dates.map((d) => d.split("-").reverse().join("/")).join(", du ") || "?"}` } : null });
      await save(blob);
      const text = `Vidéo enregistrée dans « ${save.fileName} » : ${(blob.size / 1e6).toFixed(1)} Mo, `
        + `${Math.round((Date.now() - t0) / 1000)} s de calcul.`;
      setStatus(text);
      notice(text);
    } catch (error) {
      setStatus(error.name === "AbortError" ? "Vidéo arrêtée : rien d'enregistré." : `Vidéo impossible : ${error.message}`,
        error.name === "AbortError" ? "" : "echec");
      if (error.name !== "AbortError") notice(`Vidéo impossible : ${error.message}`);
    } finally {
      videoRun = null;
      updatePlayer();
    }
  });
  $("#parcours-video-arret").addEventListener("click", () => videoRun?.abort());
  for (const id of ["#video-vitesse", "#video-photos", "#video-rampe", "#video-regard"]) $(id).addEventListener("change", updatePlayer);

  /** PR de chaque photo (photo.pr : { route, n, m }, m en mètres depuis le PR n, ou null) pour le compteur de la
   * vidéo : sur la route du parcours (route), sinon sur celle du lieu (autre route après une bifurcation). Sections et PR
   * gardés en cache par Lieu : une requête par section, pas par photo. */
  async function prOfPhotos(photos, route) {
    const roads = /^[A-Z]+\d/.test(route) ? [route] : [];  // routes déjà vues, celle du parcours d'abord
    let asked = null;  // dernier lieu demandé : voie sans numéro (sans PR), pas redemandé avant 50 m
    for (const photo of photos) {
      const [lon, lat] = photo.coords;
      let voie = "", text = "";
      for (const road of roads) {
        text = await Lieu.milestone(road, lon, lat).catch(() => "");
        if (text) {
          voie = road;
          break;
        }
      }
      // Hors des routes déjà vues : la route du lieu, une fois (ensuite ses PR, en cache, suffisent) ; voie sans numéro :
      // redemandée tous les 50 m au plus
      if (!text && (!asked || metresBetween(asked, photo.coords) > 50)) {
        asked = photo.coords;
        [text, voie] = await Lieu.describe(lon, lat).then(({ parts }) => [parts.pr || "", parts.voie || ""]).catch(() => ["", ""]);
        if (/^[A-Z]+\d/.test(voie) && !roads.includes(voie)) roads.push(voie);
      }
      const m = /^PR (\d+) ([+-])(\d+)$/.exec(text);
      photo.pr = m ? { route: voie, n: Number(m[1]), m: (m[2] === "-" ? -1 : 1) * Number(m[3]) } : null;
    }
  }

  /** Photos du parcours préparé retenues pour la vidéo : une sur n (liste « Photos »), la dernière toujours. */
  function videoPhotos() {
    const n = Number($("#video-photos").value), all = videoPlan?.photos || [];
    return all.filter((_, i) => i % n === 0 || i === all.length - 1);
  }

  /** Changement de séquence du parcours préparé, à signaler avant la vidéo. */
  const videoWarning = () => `Le parcours passe par ${videoPlan.switches + 1} séquences`
    + (videoPlan.dates.length > 1 ? ` (${videoPlan.dates.join(", ")})` : "")
    + " : les photos peuvent différer (date, lumière, sens de prise de vue).";

  /** Parcours préparé : photos retenues, écart moyen, durée de la vidéo et photos par seconde (au-delà d'une par
   * image, 30/s, des photos sont sautées), changement de séquence. */
  function videoInfo() {
    if (!videoPlan) return videoPreparing ? "recherche des photos du parcours…" : "";
    if (videoPlan.photos.length < 2) return "moins de deux photos sur ce parcours";
    const v = Number($("#video-vitesse").value) / 3.6;
    const path = Video.trajectory(videoPhotos());
    const n = path.list.length, perSecond = v * (n - 1) / Math.max(1, path.length);
    return `${n} photos (une tous les ${(path.length / Math.max(1, n - 1)).toFixed(0)} m) · `
      + `${Math.round(Video.duration(videoPhotos(), v * 3.6, $("#video-rampe").checked,
        $("#video-regard").checked ? videoPlan.junctions : [], Number($("#regard-vitesse").value)))} s · `
      + `${perSecond.toFixed(perSecond < 10 ? 1 : 0)} photos/s${$("#video-rampe").checked ? " au plus" : ""}`
      + (perSecond > Video.FPS ? " (photos sautées)" : "") + (videoPlan.switches ? ` ⚠ ${videoWarning()}` : "");
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
    $("#parcours-export").disabled = on || tourViews.length < 2 || !webpOk;
    const plan = videoPlan?.photos || [];
    $("#parcours-video").disabled = !videoOk || !videoReady || videoPreparing || Boolean(videoRun)
      || Boolean(videoPlan && plan.length < 2);
    $("#parcours-video").textContent = videoPlan ? "🎬 Enregistrer la vidéo" : "🎬 Préparer la vidéo";
    $("#parcours-video-arret").hidden = !videoRun;
    for (const id of ["#video-vitesse", "#video-photos", "#video-flou", "#video-expo", "#video-rampe", "#video-titre",
      "#video-compteur", "#video-pano", "#video-regard", "#video-tonneau", "#tonneau-duree", "#regard-vitesse"]) {
      $(id).disabled = Boolean(videoRun);
    }
    if (!videoRun) $("#video-info").textContent = videoOk ? videoInfo() : "ce navigateur n'encode pas la vidéo";
    // Écart des photos de chaque choix, d'après l'écart médian des photos du parcours préparé
    const gaps = plan.slice(1).map((p, i) => metresBetween(plan[i].coords, p.coords)).sort((a, b) => a - b);
    const gap = gaps[gaps.length >> 1];
    for (const option of $("#video-photos").options) {
      option.textContent = `Photos 1/${option.value}` + (gap ? ` · une tous les ${Math.round(gap * option.value)} m` : "");
    }
    $("#parcours-vues").textContent = !webpOk ? "export impossible : ce navigateur n'encode pas le WebP"
      : tourViews.length ? `${tourTitle} : ${tourViews.length} vues${on && tour ? " (lecture en cours)" : ""}` : "aucun parcours";
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
    psv.addEventListener("sequence-stopped", () => {
      updatePlayer();
      refresh();  // hauteur de chute d'un pont : calculée hors lecture
    });
    psv.addEventListener("picture-loaded", (event) => {
      // Lecture rapide : photo demandée affichée, la suivante après la durée de transition de
      // la visionneuse (comme sa lecture 1x)
      if (fast && event.detail?.picId === fast.id) {
        const run = fast;
        if (tour && !tourStep(run)) return;
        run.timer = setTimeout(async () => {
          // Parcours : tuiles HD de la vue chargées avant la vue gardée pour l'export et la photo suivante
          // (la visionneuse ne les coupe que pendant sa propre lecture rapide, pas pendant celle-ci)
          if (tour) await tilesLoaded(run);
          if (run !== fast) return;
          if (tour && tourViews.length < Hyperlapse.MAX_FRAMES && webpOk) {
            const view = await Hyperlapse.grab(psv).catch(() => null);
            if (view) tourViews.push(view);
          }
          fastStep(run);
        }, psv.getTransitionDuration?.() ?? 250);
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
  let singleM = null;  // relevé, une seule visée : précision (m) de l'objet gardé sur cette photo
  let tiltReady = false;  // calage de l'inclinaison : pied et sommet placés (bouton « Valider l'objet vertical »)
  let newMeasure = null;  // largeur faite : nom du point de référence (bouton « Nouvelle mesure depuis A »)
  let lineDrawn = false;  // droite de mesure tracée sur la carte, en attente du point A (#28)
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
  const reticle = (color) => "<svg xmlns='http://www.w3.org/2000/svg' width='33' height='33'>"
    + `<circle cx='16.5' cy='16.5' r='15' fill='none' stroke='${color}' stroke-width='2.5'/>`
    + "<path d='M16.5 2v11M16.5 20v11M2 16.5h11M20 16.5h11' stroke='#ff8a80' stroke-width='1.5'/>"
    + "<circle cx='16.5' cy='16.5' r='1' fill='white'/></svg>";
  const reticleColor = (tilted, calibrating, sighting) => calibrating ? CALAGE : sighting ? VISEE : tilted ? "#2ecc40" : "#ffeb00";
  // .sur-droite : réticule tenu sur la droite de mesure (slideOnGuide), qui remplace le pointeur
  const cursorCss = (tilted, calibrating, sighting) => `.psv-container, .psv-container * { cursor: url("data:image/svg+xml;utf8,${
    encodeURIComponent(reticle(reticleColor(tilted, calibrating, sighting)))}") 16 16, crosshair !important; }
    .psv-container .psv-virtual-tour-link, .psv-container .psv-virtual-tour-link * { cursor: pointer !important; }
    .psv-container.sur-droite, .psv-container.sur-droite * { cursor: none !important; }`;
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
    const calibrating = measuring && mode === "tilt";
    $("#vue").classList.toggle("visee", sighting);
    $("#vue").classList.toggle("prise", taking);
    $("#vue").classList.toggle("calage", calibrating);
    // Largeur, hauteur, mesure libre : trait vertical au centre de la vue, le cap tracé sur la
    // carte ; la vue tournée vers le point à viser (take_aim_frame), il le désigne (ticket #26)
    $("#axe-vue").hidden = !measuring || !["road", "height", "tri", "releve"].includes(mode) || viewer.hidden;
    // Même état en toutes lettres, sous le rappel du mode (comme les voyants)
    // Carte d'étape (en bas, en mesure) : nom de la mesure et ses étapes, la courante en couleur
    $("#vue").classList.toggle("en-mesure", measuring);
    const [title, steps, current] = mode === "height" ? ["Hauteur", ["Pied", "Sommet"], aiming ? 0 : newMeasure ? 2 : 1]
      : mode === "road" ? ["Largeur", ["Premier bord", "Bord opposé"], aiming && !edgeBAiming ? 0 : newMeasure ? 2 : 1]
      : mode === "tri" ? ["Mesure libre", ["Points visés depuis plusieurs photos"], 0]
      : mode === "releve" ? ["Relevé d'objets", ["Objet visé", "Ses champs"], 0]
      : ["Calage de l'inclinaison", ["Deux objets verticaux"], 0];
    $("#nom-mesure").textContent = title;
    $("#etapes").replaceChildren(...steps.map((step, k) => Object.assign(document.createElement("li"), {
      textContent: step, className: k < current ? "faite" : k === current ? "courante" : "" })));
    const state = $("#etat-mesure");
    state.hidden = !sighting && !taking;
    state.className = sighting ? "visee" : taking ? "prise" : "";
    state.textContent = sighting ? "Triangulation en cours" : taking ? "Mesure en cours" : "";
    $("#mode-mesure").textContent = mode === "tri"
      ? "Mesure libre : visez chaque point depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "releve" ? "Relevé d'objets : visez l'objet depuis plusieurs photos puis « Valider le point triangulé », ou gardez-le sur une seule photo"
      : mode === "height" && aiming ? "Hauteur, étape 1 : visez le pied depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "height" && newMeasure ? `Hauteur faite : cliquez une de ses croix pour l'ajuster ; autre hauteur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "height" ? "Hauteur, étape 2 : cliquez le sommet (le pied est le point visé) ; autre photo : par la carte"
      : mode === "road" && edgeBAiming ? "Largeur, bord opposé : le clic de la mesure est la 1re visée ; photo suivante, même bord, puis « Valider le point triangulé »"
      : mode === "road" && aiming ? "Largeur, étape 1 : visez le premier bord depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "road" && newMeasure ? `Largeur faite : cliquez une de ses croix pour l'ajuster ; autre largeur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "road" ? "Largeur, étape 2 : cliquez le bord opposé ; autre photo, prise avant ou après : par la carte"
      : mode === "tilt" ? "Calage de l'inclinaison : pied puis sommet de deux objets verticaux, à 90° l'un de l'autre"
      : "Mode mesure en cours : désélectionner pour naviguer";
    // Nom de la mesure et étape déjà dans l'en-tête de la carte d'étape (« Hauteur, étape 1 : »…) : retirés
    const tip = $("#mode-mesure").textContent.replace(/^(?:Hauteur|Largeur|Mesure libre|Relevé d'objets|Calage de l'inclinaison)[^:]*: /, "");
    $("#mode-mesure").textContent = tip[0].toUpperCase() + tip.slice(1);
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
    crossAt = app ? JSON.parse(app.pick_points()) : [];
    // « Avec les mesures » : seulement s'il y a une mesure (valeur en mètres) sur la photo affichée
    $("#vignette").disabled = !photo || !marks.some((m) => !m.guide && /\d m\b/.test(m.label || ""));
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
    // traits, croix et étiquettes des mesures : dessinés en WebGL (Traits), sous les repères HTML de la couche
    const lines = [], crosses = [], labels = [];
    marks.forEach((mark) => {
      const points = mark.points.map(([yaw, pitch]) => ({ yaw, pitch }));
      if (mark.guide) {  // sans croix : droite de mesure (largeur, tirets bleus), verticale (hauteur,
        // tirets verts), visée d'une autre photo (ligne épipolaire, trait plein vert)
        if (points.length >= 2) {
          lines.push({ points: mark.points, color: mark.vertical || mark.epipolar ? "#2ecc40" : "#00bce6", width: 2,
            dash: mark.epipolar ? null : [8, 5] });
        }
        return;
      }
      if (mark.name) {  // nom d'un point triangulé : étiquette seule, du côté opposé à la mesure ;
        // grise pour le bord cliqué d'une largeur, pas encore triangulé (nom provisoire)
        labels.push({ at: mark.points[0], type: "nom", place: mark.side || "below", text: mark.label, provisional: mark.provisional });
        return;
      }
      if (points.length >= 2) {  // objet vertical du calage de l'inclinaison : bleu clair ; mesure : rouge
        lines.push({ points: mark.points, color: mark.calage ? "#8ee8ff" : "#e53935", width: mark.calage ? 2 : 4, dash: null });
      }
      // croix jaunes, bleues pour les visées, rouge clair en calage ; la choisie dans un cercle
      const color = mark.sighting ? "#00bce6" : mark.calage ? "#ff8a80" : "#ffeb00";
      mark.points.forEach(([yaw, pitch, sel]) => {
        crosses.push({ at: [yaw, pitch], color, ring: sel ? (mark.calage ? "#ff8a80" : "#ffeb00") : null,
          visee: !!mark.sighting, calage: !!mark.calage });
      });
      if (mark.label && mark.end && points.length >= 2) {
        // Hauteur, largeur : étiquette au point d'arrivée (à droite du sommet, sous le bord), ouverte par son nom
        // (pastille bordeaux, grise s'il est provisoire) ; écartée vers le bas d'une autre, avec un trait de renvoi
        labels.push({ at: mark.points[mark.points.length - 1], type: "fin", place: mark.beside ? "cote" : "dessous",
          text: measureLabel(mark, names), chip: mark.end.name, provisional: mark.end.provisional });
      } else if (mark.label) {  // au milieu du trait, un peu au-dessus (à côté pour une hauteur)
        const mid = middle(points);
        labels.push({ at: [mid.yaw, mid.pitch], type: "mesure", place: mark.beside ? "cote" : "dessus", text: measureLabel(mark, names) });
      }
    });
    // Couche importée : lignes et contours en traits de sa couleur, points en pastilles, étiquettes
    if (overlay && app && $("#couche-visible").checked) {
      let points = 0, n = 0, rank = 0;
      overlayAt.clear();
      const masked = overlayMasked();
      for (const o of JSON.parse(app.overlay_marks())) {
        const p = overlay.features[o.id]?.properties || {};
        if (masked.has(p._cle)) continue;  // valeur masquée dans la légende
        const color = p._couleur || "#66cc66";
        const chosen = o.id === movingId() ? " choisie" : "";
        const anchorOf = (pts) => (o.kind === "point" ? { yaw: pts[0][0], pitch: pts[0][1] }
          : middle(pts.map(([yaw, pitch]) => ({ yaw, pitch }))));
        if (!overlayAt.has(o.id)) overlayAt.set(o.id, anchorOf(o.points));
        const { kind, pts } = overlayPoints(o);
        const at = kind === "point" ? { yaw: pts[0][0], pitch: pts[0][1] } : middle(pts.map(([yaw, pitch]) => ({ yaw, pitch })));
        if (kind === "ligne" && pts.length >= 2) lines.push({ points: pts, color, width: chosen ? 5 : 2.5, dash: null, couche: true });
        // data-objet : clic pour le recaler (attachViewer)
        if (kind === "point" && points++ < 300) {
          add({ id: `${MARK}couche-${n++}`, position: at, anchor: "center center",
            html: `<div class="pastille-couche${chosen}" data-objet="${o.id}" style="background:${color}"></div>` });
        }
        if (p._etiquette) {  // rang : 0 pour la plus proche de la caméra (marques triées par distance)
          add({ id: `${MARK}couche-${n++}`, position: at, anchor: "center center", zIndex: OVERLAY_LABEL_Z,  // au-dessus des pastilles
            html: `<div class="ancre"><div class="etiquette couche dessus${chosen}" data-objet="${o.id}" data-rang="${rank++}" style="color:${Couche.clair(color)}">${escapeHtml(p._etiquette)}</div></div>` });
        }
      }
    }
    Traits.attach(psv);
    Traits.set(lines, { crosses, labels });
    markers.renderMarkers?.();
    requestAnimationFrame(() => requestAnimationFrame(declutterLabels));  // une fois placées
  }

  /**
   * Étiquettes des points d'arrivée qui se chevauchent (sommets ou bords proches) : écartées
   * vers le bas, de la plus haute à la plus basse, l'ordre gardé ; un trait relie l'étiquette
   * écartée à sa croix. Les autres étiquettes (noms, mesures libres) restent en place et sont
   * évitées. Refait quand la vue tourne ou zoome.
   */
  function declutterLabels() {
    const root = viewer;
    if (!root) return;
    const overlayLabels = [...root.querySelectorAll(".etiquette.couche")];
    for (const el of overlayLabels) el.style.setProperty("--decalage", "0px");
    const placed = Traits.labelRects();  // étiquettes des mesures (WebGL), écartées entre elles à chaque image
    const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom + 2 && a.bottom + 2 > b.top;
    // Couche importée : de la plus proche de la caméra à la plus lointaine, chacune remontée au-dessus
    // de celles déjà placées ; masquée s'il faudrait la remonter de plus de OVERLAY_MAX_LIFT fois sa
    // hauteur (trop loin de son point pour s'y rapporter)
    for (const el of overlayLabels) el.style.visibility = "";
    const labels = overlayLabels.map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width).sort((a, b) => a.el.dataset.rang - b.el.dataset.rang);
    for (const { el, rect } of labels) {
      const limit = OVERLAY_MAX_LIFT * (rect.bottom - rect.top);
      let shift = 0, r = rect;
      for (let other = placed.find((p) => hit(r, p)); other && -shift <= limit; other = placed.find((p) => hit(r, p))) {
        shift -= r.bottom + 2 - other.top;
        r = { left: rect.left, right: rect.right, top: rect.top + shift, bottom: rect.bottom + shift };
      }
      if (-shift > limit) {
        el.style.visibility = "hidden";
        continue;
      }
      el.style.setProperty("--decalage", `${shift}px`);
      placed.push(r);
    }
  }
  const OVERLAY_MAX_LIFT = 1.5;
  const OVERLAY_LABEL_Z = 20;  // étiquettes de la couche : jamais recouvertes par une pastille (repères à 1)
  let declutterPending = false;
  let declutterTimer = null;
  const scheduleDeclutter = () => {
    if (declutterPending) return;
    declutterPending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { declutterPending = false; declutterLabels(); }));
  };

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
    const match0 = /^([↔↕]) (.*)$/.exec(mark.label);
    if (mark.names?.length && match0) {  // hauteur, largeur : noms donnés par le cœur
      const sorted = [...mark.names].sort((a, b) => a.localeCompare(b, "fr"));
      return sorted.length === 1 ? `${sorted[0]}${match0[1]} ${match0[2]}` : `${sorted.join(match0[1])} ${match0[2]}`;
    }
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
      // Incertitude attendue du point avec cette visée en plus (voir App.guide)
      const m = (v) => v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const label = choice.expect == null ? choice.label : `${choice.label} · ±${m(choice.expect)} m`;
      const title = choice.expect == null ? choice.title : `${choice.title}. Incertitude attendue du point : `
        + (choice.now == null ? `±${m(choice.expect)} m` : `±${m(choice.now)} m → ±${m(choice.expect)} m`);
      const button = Object.assign(document.createElement("button"), { type: "button",
        textContent: arrow === "◀" ? `◀ ${label}` : arrow ? `${label} ${arrow}` : label, title });
      button.addEventListener("click", () => goToPhoto(choice.id));
      return button;
    }).sort((a, b) => a.textContent.startsWith("◀") ? -1 : b.textContent.startsWith("◀") ? 1 : 0));  // ◀ à gauche
  }

  /**
   * Vue cadrée sur des points de la photo ([[cap, élévation]] en radians, repère de la photo) :
   * centrée sur eux, zoom ajusté pour les voir tous (le point A seul, ou la largeur de A à B).
   */
  function frameView(points, keepZoom = false, crop = null) {  // crop : {aspect, margin} de l'image à tirer de la vue
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
    const vfov = crop  // la mesure entière dans l'image recadrée au centre de la vue, avec sa marge
      ? Math.min(maxFov, Math.max(2, deg(spreadPitch) * crop.margin, deg(spreadYaw) * crop.margin / crop.aspect)
        * Math.max(1, crop.aspect / aspect))
      : Math.min(maxFov, Math.max(points.length > 1 ? 20 : 35, deg(spreadPitch) * 1.3, deg(spreadYaw) * 1.3 / aspect));
    const zoom = psv.dataHelper?.fovToZoomLevel ? psv.dataHelper.fovToZoomLevel(vfov) : undefined;
    psv.animate({ yaw, pitch, ...(zoom == null || keepZoom ? {} : { zoom }), speed: 1200 });
  }

  /** Photo d'identifiant id ouverte, chargée et ses repères dessinés (fiche, mesure revue) ; 30 s au plus. */
  async function openPhotoReady(id) {
    await goToPhoto(id);
    const t0 = Date.now();
    while (psv?.getPictureMetadata?.()?.id !== id || !photoReady()) {
      if (Date.now() - t0 > 30000) throw new Error("photo de la mesure non chargée");
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 1500));  // repères de la photo dessinés
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
    // « Nouveau point de référence » : hauteur seulement (sans utilité en largeur), une fois le point validé
    $("#nouvelle-reference").hidden = !measuring || mode !== "height" || aiming || viewer.hidden;
    // « Valider le point triangulé », dans la visionneuse : dès que les visées donnent un point
    $("#garder").hidden = !measuring || !aiming || !pointReady || viewer.hidden;
    // Relevé, une seule visée : la question, avec la précision ; sinon viser depuis une autre photo
    $("#garder-seul").hidden = !measuring || mode !== "releve" || singleM == null || viewer.hidden;
    if (singleM != null) $("#garder-seul").textContent = `✔ Garder sur cette seule photo (± ${String(singleM).replace(".", ",")} m)`;
    $("#valider-objet").hidden = !measuring || !tiltReady || viewer.hidden;
    $("#nouvelle-mesure").hidden = !measuring || !newMeasure || viewer.hidden;
    $("#placer-carte").hidden = !measuring || mode !== "releve" || viewer.hidden;
    if (placing && $("#placer-carte").hidden) setPlacing(false);  // mesure arrêtée, autre mode
    $("#trianguler-b").hidden = !measuring || !edgeBOffered || viewer.hidden;
    // Largeur, avant la première visée du point A : droite de mesure à tracer sur la carte (#28) ;
    // tracée, « Annuler la droite » jusqu'au point A
    const axis = app && mode === "road" ? JSON.parse(app.axis_state()) : {};
    lineDrawn = Boolean(axis.drawn);
    $("#axe-carte").hidden = !$("#droite-carte").checked || !measuring || !axis.can || viewer.hidden || lineDraft !== null;
    $("#axe-auto").hidden = !measuring || !axis.drawn || viewer.hidden;
    if (lineDraft === null) showDrawnLine(measuring && axis.drawn ? axis.line : null);  // jusqu'au point A
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
  $("#pont").addEventListener("change", (event) => refresh(app.set_bridge(event.target.checked)));
  $("#camera-gps").addEventListener("click", (event) => {
    $("#camera").value = Number(event.target.dataset.value).toFixed(2);
    setCamera();
  });
  $("#valider-objet").addEventListener("click", () => refresh(app.validate_tilt()));
  $("#garder").addEventListener("click", () => {
    const before = app.has_releve() ? app.releve_json() : "";
    refresh(app.keep_point());
    const reference = app.take_goto();  // retour sur la photo de référence, pour la mesure
    if (reference) goToPhoto(reference);
    if ($("#mode").value === "releve" && app.releve_json() !== before) editReleve(null, true);
  });
  $("#garder-seul").addEventListener("click", () => {
    refresh(app.keep_single());
    editReleve(null, true);
  });
  $("#nouvelle-mesure").addEventListener("click", () => refresh(app.new_measure()));
  $("#trianguler-b").addEventListener("click", () => refresh(app.start_edge_b()));
  $("#axe-carte").addEventListener("click", () => startLineDraft());
  $("#axe-auto").addEventListener("click", () => refresh(app.cancel_measure_line()));
  $("#nouvelle-reference").addEventListener("click", () => refresh(app.new_reference()));
  $("#effacer").addEventListener("click", () => {  // comme Ctrl+Z : le dernier geste (onUndoKey)
    refresh(app.undo());
    proposeDistance();
  });
  $("#refaire").addEventListener("click", () => {  // comme Ctrl+Y : ce que le dernier « Effacer » a retiré
    refresh(app.redo());
    proposeDistance();
  });
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
    $("#filtre-infos").textContent = !active ? "aucun" : app ? app.filter_text() : "en attente du calcul";
    if (app) checkPhoto();  // sans le calcul, le filtre n'est pas encore évalué
  }

  /** Clic de mesure trop peu zoomé (un pixel de l'écran couvre plus de 2 pixels de la photo) :
   * rappel de zoomer, une fois par photo. */
  const zoomReminded = new Set();
  function remindZoom() {
    const width = psv.state.textureData?.panoData?.fullWidth || 12288;  // photo HD imajbox
    const height = psv.container.clientHeight;
    if (!photo || zoomReminded.has(photo.id) || !height || viewFov(true) / height <= 2 * 360 / width) return;
    zoomReminded.add(photo.id);
    notice("Zoomez sur le point pour cliquer plus précisément : à ce zoom, un clic couvre plusieurs pixels de la photo.");
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

  let exported = null;  // export GeoJSON (commentaires compris) lors du dernier export

  $("#csv").addEventListener("click", async () => {
    const geojson = app.export_geojson();
    if (await download("\ufeff" + app.export_csv(), "mesures.csv", "text/csv")) exported = geojson;
    saveResults();
    showResultsInfo();
  });
  $("#geojson").addEventListener("click", async () => {
    const geojson = app.export_geojson();
    if (await download(geojson, "mesures.geojson", "application/geo+json")) exported = geojson;
    saveResults();
    showResultsInfo();
  });

  // Relevé d'objets ---------------------------------------------------------------------------
  // Objets gardés dans le navigateur d'une séance à l'autre (App.releve_json) ; champs définis au
  // premier objet (nom, type), gardés avec eux, et proposés pour tous les suivants.

  const RELEVE_TYPES = { texte: "Texte", nombre: "Nombre", date: "Date", oui_non: "Oui / non", liste: "Liste de valeurs" };
  // Colonnes déjà remplies par l'application : un champ ne peut pas porter leur nom
  const RELEVE_RESERVES = ["id", "nb_visees", "angle", "incert_m", "ecart_m", "dist_max_m", "gps_m", "z_ngf",
    "photos", "date_mesure", "commentaire", "voie", "pr", "commune", "lon", "lat"];
  let releveSaved = null;

  function releveFields() {
    try { return JSON.parse(store.get("releve-champs") || "[]"); } catch { return []; }
  }

  function saveReleve() {
    const n = JSON.parse(app.results()).filter((r) => r.releve).length;
    $("#releve-couche").disabled = !n;
    $("#releve-vider").disabled = !n;
    $("#releve-infos").textContent = n ? `${n} objet${n > 1 ? "s" : ""}` : "Aucun objet";
    const json = n ? app.releve_json() : "";
    if (json === releveSaved) return;
    releveSaved = json;
    store.set("releve", json);
  }

  // Relevé envoyé dans Couche (il y prend les réglages d'une couche importée) ; une couche chargée est
  // d'abord retirée, enregistrée si on le demande
  $("#releve-couche").addEventListener("click", () => {
    if (!overlay) return sendReleve();
    const dialog = $("#remplacer-couche");
    dialog.querySelector("p span").textContent = overlay.name;
    dialog.returnValue = "";
    dialog.addEventListener("close", async () => {
      if (dialog.returnValue === "enregistrer" && !(await exportOverlay())) return;  // enregistrement annulé : rien ne change
      if (dialog.returnValue) sendReleve();
    }, { once: true });
    showOverViewer(dialog);
  });
  function sendReleve() {
    const data = JSON.parse(app.export_geojson(true));
    for (const f of data.features) {  // altitude du point visé : l'objet y est dessiné dans la photo
      if (typeof f.properties.z_ngf === "number") f.geometry.coordinates.push(f.properties.z_ngf);
    }
    const name = `Relevé du ${new Date().toLocaleDateString("fr-FR")}`;
    const n = loadOverlay(name, Couche.read(JSON.stringify(data)), "", "", true);
    setOverlayFile(null);
    setOverlayChanged(true);  // dans aucun fichier encore
    const kept = saveOverlay();
    showPane("couche");
    refresh();
    setStatus(`${name} envoyé dans Couche : ${n} objet${n > 1 ? "s" : ""}.`
      + (kept ? "" : " Trop gros pour être gardé dans le navigateur : exportez-le."));
  }
  $("#releve-vider").addEventListener("click", () => {
    const dialog = $("#vider-releve"), n = JSON.parse(app.results()).filter((r) => r.releve).length;
    dialog.querySelector("p span").textContent = `${n} objet${n > 1 ? "s" : ""}`;
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "vider") refresh(app.clear_releve());
    }, { once: true });
    showOverViewer(dialog);
  });

  /** Ligne de définition d'un champ : nom, type, valeurs de la liste ; fixed : champ déjà créé, gardé
   * tel quel et masqué (seuls les nouveaux champs se définissent). */
  function fieldRow(field = { nom: "", type: "texte", valeurs: [] }, fixed = false) {
    const li = Object.assign(document.createElement("li"), { hidden: fixed }), row = document.createElement("div");
    const name = Object.assign(document.createElement("input"), { type: "text", value: field.nom, placeholder: "Nom du champ (ex. distance_bord_m)", className: "nom" });
    const type = Object.assign(document.createElement("select"), { className: "type" });
    type.append(...Object.entries(RELEVE_TYPES).map(([value, text]) => new Option(text, value, false, value === field.type)));
    const values = Object.assign(document.createElement("input"), { type: "text", value: (field.valeurs || []).join(" ; "),
      placeholder: "Valeurs séparées par « ; »", className: "valeurs", hidden: field.type !== "liste" });
    const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: "Retirer ce champ" });
    remove.setAttribute("aria-label", "Retirer ce champ");
    const changed = () => { values.hidden = type.value !== "liste"; showFieldInputs(readFields(), {}); showKeepModel(); };
    for (const input of [name, type, values]) input.addEventListener("input", changed);
    remove.addEventListener("click", () => { li.remove(); changed(); });
    row.append(name, type, remove);
    li.append(row, values);
    return li;
  }

  function readFields() {
    return [...$("#releve-champs").children].map((li) => ({
      nom: li.querySelector(".nom").value.trim(), type: li.querySelector(".type").value,
      valeurs: li.querySelector(".valeurs").value.split(";").map((v) => v.trim()).filter(Boolean),
    })).filter((f) => f.nom);
  }

  /** Saisie des valeurs, une ligne par champ, préremplie par values ; champ texte : valeurs déjà saisies
   * sur les autres objets du relevé proposées dans une liste (on peut aussi en taper une nouvelle). */
  function showFieldInputs(fields, values) {
    const box = $("#releve-valeurs");
    const others = app.has_releve() ? JSON.parse(app.releve_json()).points.map(([, , v]) => v.releve || {}) : [];
    const kept = Object.fromEntries([...box.querySelectorAll("[data-champ]")].map((i) => [i.dataset.champ, i]));
    box.replaceChildren(...fields.flatMap((f, k) => {
      const id = `releve-champ-${k}`, old = kept[f.nom];
      const label = Object.assign(document.createElement("label"), { htmlFor: id, textContent: f.nom });
      let input;
      if (f.type === "liste") {
        input = document.createElement("select");
        input.append(new Option("—", ""), ...f.valeurs.map((v) => new Option(v, v)));
      } else {
        input = Object.assign(document.createElement("input"), {
          type: { nombre: "number", date: "date", oui_non: "checkbox" }[f.type] || "text" });
        if (f.type === "nombre") input.step = "any";
      }
      Object.assign(input, { id });
      input.dataset.champ = f.nom;
      input.dataset.type = f.type;
      const value = f.nom in values ? values[f.nom] : old && old.dataset.type === f.type ? (old.type === "checkbox" ? old.checked : old.value) : null;
      if (f.type === "oui_non") input.checked = value === true;
      else if (value != null) input.value = String(value);
      const used = f.type === "texte" ? [...new Set(others.map((v) => v[f.nom]).filter((v) => typeof v === "string" && v.trim()))]
        .sort((a, b) => a.localeCompare(b, "fr")) : [];
      if (!used.length) return [label, input];
      const list = Object.assign(document.createElement("datalist"), { id: `${id}-valeurs` });
      list.append(...used.map((v) => new Option(v)));
      input.setAttribute("list", list.id);
      input.autocomplete = "off";  // seulement les valeurs du relevé, pas l'historique du navigateur
      return [label, input, list];
    }));
  }

  /** Défaut d'une liste de champs (vide : aucun) : au moins un, nom libre et unique, valeurs d'une liste. */
  function fieldsError(list) {
    const names = list.map((f) => f.nom), reserved = names.find((n) => RELEVE_RESERVES.includes(n));
    const empty = list.find((f) => f.type === "liste" && !f.valeurs.length);
    return !list.length ? "Ajoutez au moins un champ."
      : reserved ? `« ${reserved} » est déjà une colonne de l'export : choisissez un autre nom.`
      : new Set(names).size < names.length ? "Deux champs portent le même nom."
      : empty ? `Donnez les valeurs de la liste « ${empty.nom} ».`
      : "";
  }

  // Modèles de champs (ticket #33) : structures de relevé gardées sous un nom dans le navigateur, et
  // échangées par fichier entre postes
  const MODELES_FORMAT = "web-measures/modeles-releve";

  function releveModels() {
    try { return JSON.parse(store.get("releve-modeles") || "[]"); } catch { return []; }
  }

  function setReleveModels(models) {
    store.set("releve-modeles", JSON.stringify(models.sort((a, b) => a.nom.localeCompare(b.nom, "fr"))));
    showReleveModels();
  }

  /** Liste des modèles (choix gardé), boutons sans effet possible grisés, case « Garder comme modèle ». */
  function showReleveModels() {
    const models = releveModels(), select = $("#releve-modele"), chosen = select.value;
    select.replaceChildren(new Option("— aucun —", ""), ...models.map((m) => new Option(m.nom, m.nom)));
    select.value = models.some((m) => m.nom === chosen) ? chosen : "";
    select.disabled = !models.length;
    $("#releve-modele-retirer").disabled = !select.value;
    $("#releve-modeles-exporter").disabled = !models.length;
    showKeepModel();
  }

  /** « Garder ces champs comme modèle » : proposé quand des champs se définissent ou s'ajoutent et
   * qu'aucun modèle n'a exactement les mêmes. */
  function showKeepModel() {
    const list = readFields(), same = JSON.stringify(list);
    $("#releve-garder-modele").hidden = list.length <= releveFields().length
      || releveModels().some((m) => JSON.stringify(m.champs) === same);
  }

  /** Modèles valides d'un fichier exporté (MODELES_FORMAT) : nom, champs comme à la saisie. */
  function readModels(data) {
    if (data?.format !== MODELES_FORMAT || !Array.isArray(data.modeles)) return [];
    return data.modeles.flatMap((m) => {
      const champs = (Array.isArray(m?.champs) ? m.champs : []).map((f) => ({ nom: String(f?.nom ?? "").trim(), type: f?.type,
        valeurs: Array.isArray(f?.valeurs) ? f.valeurs.map((v) => String(v).trim()).filter(Boolean) : [] }));
      const ok = typeof m.nom === "string" && m.nom.trim() && !fieldsError(champs)
        && champs.every((f) => f.nom && Object.hasOwn(RELEVE_TYPES, f.type));
      return ok ? [{ nom: m.nom.trim().slice(0, 60), champs }] : [];
    });
  }

  // Colonnes techniques d'un KML converti (GDAL, togeojson) : style et affichage, pas des données
  const KML_TECHNIQUES = ["timestamp", "begin", "end", "altitudemode", "tessellate", "extrude", "visibility", "draworder",
    "icon", "snippet", "styleurl", "stylehash", "stylemaphash"];

  /** Champs d'un modèle tirés des colonnes de la couche, sans celles que remplit l'application, ni la
   * position, ni les colonnes techniques d'un KML (casse ignorée) ; type d'après les valeurs : nombres,
   * oui / non, dates AAAA-MM-JJ, sinon texte (liste s'il a 12 valeurs de 40 caractères au plus,
   * chacune deux fois en moyenne). */
  function overlayFields() {
    const filled = new Set([...RELEVE_RESERVES, ...overlay.techniques, ...KML_TECHNIQUES, "latitude", "longitude"]
      .map((c) => c.toLowerCase()));
    return overlay.columns.filter((c) => c.trim() && !filled.has(c.toLowerCase())).map((nom) => {
      const values = overlay.features.map((f) => f.properties[nom]).filter((v) => v !== null && v !== undefined && v !== "");
      const all = (test) => values.length > 0 && values.every(test);
      const distinct = [...new Set(values.map(String))];
      const type = all((v) => typeof v === "number") ? "nombre" : all((v) => typeof v === "boolean") ? "oui_non"
        : all((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? "date"
        : all((v) => typeof v === "string" && v.length <= 40) && distinct.length <= 12 && distinct.length * 2 <= values.length ? "liste" : "texte";
      return { nom, type, valeurs: type === "liste" ? distinct.sort((a, b) => a.localeCompare(b, "fr")) : [] };
    });
  }

  $("#couche-modele").addEventListener("click", () => {
    const dialog = $("#modele-couche"), champs = overlayFields(), named = dialog.querySelector("input");
    dialog.querySelector("ul").replaceChildren(...champs.map((f) => Object.assign(document.createElement("li"), {
      textContent: `${f.nom} : ${RELEVE_TYPES[f.type].toLowerCase()}${f.valeurs.length ? ` (${f.valeurs.join(", ")})` : ""}` })));
    named.value = "";
    named.placeholder = overlay.name.replace(/\.[^.]+$/, "").slice(0, 60);
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "garder") return;
      const nom = named.value.trim() || named.placeholder;
      setReleveModels([...releveModels().filter((m) => m.nom !== nom), { nom, champs }]);
      setStatus(`Modèle « ${nom} » enregistré : à choisir au premier objet d'un relevé.`);
    }, { once: true });
    showOverViewer(dialog);
  });

  $("#releve-modele").addEventListener("change", () => {
    const model = releveModels().find((m) => m.nom === $("#releve-modele").value);
    if (model) $("#releve-champs").replaceChildren(...model.champs.map((f) => fieldRow(f)));
    showFieldInputs(readFields(), {});
    showReleveModels();
  });
  $("#releve-modele-retirer").addEventListener("click", () => {
    const dialog = $("#retirer-modele"), name = $("#releve-modele").value;
    dialog.querySelector("p span").textContent = name;
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "retirer") setReleveModels(releveModels().filter((m) => m.nom !== name));
    }, { once: true });
    dialog.showModal();
  });
  $("#releve-modeles-exporter").addEventListener("click", () => download(
    JSON.stringify({ format: MODELES_FORMAT, modeles: releveModels() }, null, 2), "modeles-releve.json", "application/json"));
  $("#releve-modeles-importer").addEventListener("click", () => $("#releve-modeles-fichier").click());
  $("#releve-modeles-fichier").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file) return;
    let found = [];
    try { found = readModels(JSON.parse(await file.text())); } catch { /* pas du JSON */ }
    const error = $("#releve-erreur");
    error.textContent = found.length ? "" : `« ${file.name} » ne contient aucun modèle de champs lisible.`;
    error.hidden = Boolean(found.length);
    if (!found.length) return;
    const names = new Set(found.map((m) => m.nom));
    setReleveModels([...releveModels().filter((m) => !names.has(m.nom)), ...found]);
    setStatus(`${found.length} modèle${found.length > 1 ? "s" : ""} importé${found.length > 1 ? "s" : ""} de « ${file.name} ».`);
  });

  /** Champs de l'objet relevé n° k (null : le dernier gardé) ; fresh : objet tout juste gardé, le
   * lieu (voie, PR, commune) lu en même temps. Au premier objet du relevé, définition des champs. */
  function editReleve(k, fresh = false) {
    const objects = JSON.parse(app.results()).filter((r) => r.releve);
    const row = k == null ? objects.reduce((a, b) => (b.id > a.id ? b : a), objects[0]) : objects.find((r) => r.id === k);
    if (!row) return;
    const kept = JSON.parse(app.releve_json()).points.find(([, , v]) => v.nom === /^Objet (\S+)/.exec(row.text)[1])?.[2] || {};
    const values = kept.releve || {};
    $("#releve-commentaire input").value = kept.commentaire || "";
    if (objects.length === 1 && fresh) store.set("releve-champs", "");  // nouveau relevé : ses champs à définir
    const fields = releveFields(), defining = !fields.length;
    const place = "voie" in values ? null : Lieu.describe(...row.lonlat).catch(() => ({ parts: {} }));
    const dialog = $("#releve-objet");
    dialog.querySelector("h2 span").textContent = /^Objet (\S+)/.exec(row.text)[1];
    // Premier objet : les champs du relevé ; ensuite, d'autres champs peuvent s'ajouter (vides pour les
    // objets déjà relevés)
    $("#releve-definition legend").title = defining ? "Définis une fois, ils servent à tous les objets suivants"
      : "Pour cet objet et les suivants (vides pour les objets déjà relevés)";
    $("#releve-definition legend").textContent = defining
      ? "Champs du relevé"
      : "Nouveaux champs, si besoin";
    $("#releve-champs").replaceChildren(...fields.map((f) => fieldRow(f, true)), ...(defining ? [fieldRow()] : []));
    $("#releve-modeles").hidden = !defining;
    const [box, named] = $("#releve-garder-modele").querySelectorAll("input");
    box.checked = false;
    named.value = "";
    named.placeholder = `Modèle du ${new Date().toLocaleDateString("fr-FR")}`;
    showReleveModels();
    $("#releve-valeurs").replaceChildren();
    $("#releve-erreur").hidden = true;
    showFieldInputs(readFields(), values);
    $("#releve-enregistrer").onclick = async () => {
      const list = readFields(), error = fieldsError(list);
      $("#releve-erreur").textContent = error;
      $("#releve-erreur").hidden = !error;
      if (error) return;
      const keep = $("#releve-garder-modele"), [box, named] = keep.querySelectorAll("input");
      if (!keep.hidden && box.checked) {
        const nom = named.value.trim() || named.placeholder;
        setReleveModels([...releveModels().filter((m) => m.nom !== nom), { nom, champs: list }]);
      }
      store.set("releve-champs", JSON.stringify(list));
      const out = {};
      for (const input of $("#releve-valeurs").querySelectorAll("[data-champ]")) {
        const type = input.dataset.type;
        out[input.dataset.champ] = type === "oui_non" ? input.checked
          : type === "nombre" ? (input.value === "" ? null : Number(input.value)) : input.value;
      }
      for (const key of ["voie", "pr", "commune"]) if (key in values) out[key] = values[key];  // lieu déjà lu
      if (place) {
        const { parts = {} } = await place;
        Object.assign(out, { voie: parts.voie || "", pr: parts.pr || "", commune: parts.commune || "" });
      }
      dialog.close();
      app.set_comment("point", row.id, $("#releve-commentaire input").value.trim());
      refresh(app.set_releve(row.id, JSON.stringify(out)));
    };
    dialog.returnValue = "";
    showOverViewer(dialog);
    // Focus sur ce qui est à remplir d'abord (sinon : sur l'icône d'import des modèles)
    dialog.querySelector("#releve-champs > li:not([hidden]) .nom, #releve-valeurs [data-champ]")?.focus();
  }
  $("#releve-ajouter").addEventListener("click", () => {
    $("#releve-champs").append(fieldRow());
    $("#releve-champs").lastElementChild.querySelector(".nom").focus();
  });

  // Résultats gardés dans le navigateur à chaque changement (exports CSV et GeoJSON tout prêts) :
  // à l'ouverture suivante, ceux de la session précédente, s'ils n'ont pas été exportés, sont
  // affichés en lecture seule et proposés à l'export, pendant cette session seulement.
  // shortcut: deux onglets ouverts à la fois écrivent au même endroit ; à revoir si l'on
  // travaille en plusieurs onglets.
  let saveTimer = null, savedKey = null;
  function saveResults() {  // à chaque rafraîchissement : écrit seulement ce qui a changé
    clearTimeout(saveTimer);
    if (!app) return;
    const geojson = app.export_geojson(), key = geojson + (geojson === exported);  // exporté depuis : réécrit
    if (key === savedKey) return;
    savedKey = key;
    const n = JSON.parse(geojson).features.length;  // en mesure libre, points et distances hors de la liste (#30)
    store.set("resultats", n ? JSON.stringify({ when: Date.now(), n, exported: geojson === exported,
      csv: app.export_csv(), geojson }) : "");
  }
  {
    // Session précédente : gardée en mémoire seulement, retirée du navigateur avant que celle-ci
    // n'écrive ; non exportée pendant cette session, elle est oubliée à sa clôture
    let previous = null;
    try { previous = JSON.parse(store.get("resultats") || "null"); } catch { /* illisible : aucun */ }
    store.set("resultats", "");
    store.set("resultats-precedents", "");  // ancienne clé (versions du 24/10/2026)
    if (previous && previous.n && !previous.exported) {
      // En lecture seule : liste (tirée de l'export GeoJSON, comme en mesure libre où les points et
      // distances sont hors de la liste) et dessin gris sur la carte
      const num = (v) => (v == null ? "?" : Number(v).toLocaleString("fr-FR", { maximumFractionDigits: 2 }));
      const geojson = JSON.parse(previous.geojson);
      $("#precedents ol").replaceChildren(...geojson.features.map(({ properties: p }) => {
        const text = p.type === "point triangulé" ? `Point ${p.nom} ±${num(p.incert_m)} m`
          : p.type.startsWith("distance") ? `${p.points} ${num(p.valeur_m)} m ± ${num(p.incert_m)} m`
          : `${p.type[0].toUpperCase()}${p.type.slice(1)} : ${num(p.valeur_m)} m ± ${num(p.incert_m)} m`;
        return Object.assign(document.createElement("li"), { textContent: text + (p.commentaire ? ` — ${p.commentaire}` : "") });
      }));
      Carte.showPrevious(map, geojson);
      const when = new Date(previous.when);
      $("#precedents summary").textContent = `${previous.n} résultat${previous.n > 1 ? "s" : ""} de la session du ${
        when.toLocaleDateString("fr-FR")} à ${when.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      }, non exporté${previous.n > 1 ? "s" : ""}`;
      $("#precedents").hidden = false;
      $("#precedents-csv").addEventListener("click", () => download("\ufeff" + previous.csv, "mesures-precedentes.csv", "text/csv"));
      $("#precedents-geojson").addEventListener("click", () => download(previous.geojson, "mesures-precedentes.geojson",
        "application/geo+json"));
      $("#precedents-oublier").addEventListener("click", () => {
        $("#precedents").hidden = true;
        Carte.showPrevious(map, null);
      });
    }
  }
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

  /**
   * Fichier name à enregistrer : boîte d'enregistrement du système (Chrome, Edge), à demander dès le
   * clic (le navigateur ne l'ouvre que peu après un geste de l'utilisateur). Rend la fonction qui écrit
   * le contenu, ou null si l'utilisateur a renoncé. Sans cette boîte (Firefox, qui n'en donne pas
   * l'accès aux pages) ou si elle est refusée : téléchargement du navigateur, avec sa propre boîte si
   * « Toujours vous demander où enregistrer les fichiers » est coché.
   */
  async function saveAs(name, type) {
    // le CSV commence par une marque d'ordre des octets : accents lus par les tableurs
    const blobOf = (content) => (content instanceof Blob ? content : new Blob([content], { type: `${type};charset=utf-8` }));
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name,
          types: [{ accept: { [type]: [name.slice(name.lastIndexOf("."))] } }] });
        return Object.assign(async (content) => {
          const file = await handle.createWritable();
          await file.write(blobOf(content));
          await file.close();
        }, { fileName: handle.name });  // nom choisi, rappelé à l'utilisateur (le dossier n'est pas connu de la page)
      } catch (error) {
        if (error.name === "AbortError") return null;  // boîte fermée sans enregistrer
      }
    }
    const chosen = await askFileName(name);  // sans boîte « Enregistrer sous » (Firefox) : le nom, au moins
    if (!chosen) return null;
    return Object.assign(async (content) => {
      const url = URL.createObjectURL(blobOf(content));
      Object.assign(document.createElement("a"), { href: url, download: chosen }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, { fileName: `${chosen} (dossier des téléchargements)` });
  }

  /** Nom du fichier à télécharger, proposé (name) puis modifiable ; extension remise si elle manque ;
   * null si l'utilisateur renonce. */
  function askFileName(name) {
    const dialog = $("#nom-fichier"), input = dialog.querySelector("input");
    const ext = name.slice(name.lastIndexOf("."));
    input.value = name;
    input.onkeydown = (event) => {  // Entrée : enregistrer (le premier bouton du formulaire est « Annuler »)
      if (event.key !== "Enter") return;
      event.preventDefault();
      dialog.close("ok");
    };
    dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        const typed = input.value.trim().replace(/[\\/:*?"<>|]/g, "_");  // caractères interdits dans un nom de fichier
        if (dialog.returnValue !== "ok" || !typed) return resolve(null);
        resolve(typed.toLowerCase().endsWith(ext.toLowerCase()) ? typed : typed + ext);
      }, { once: true });
      showOverViewer(dialog);
      input.select();
    });
  }

  /** Contenu enregistré dans le fichier name (saveAs) ; faux si l'utilisateur a renoncé. */
  async function download(content, name, type) {
    const save = await saveAs(name, type);
    if (save) await save(content);
    return Boolean(save);
  }

  window.addEventListener("beforeunload", (event) => {
    if (app && app.has_results() && app.export_geojson() !== exported) event.preventDefault();  // non exportés
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
    const save = await saveAs(`${params.name}.jpg`, "image/jpeg");  // au clic, avant la capture (longue)
    if (!save) return;
    const button = $("#capture-hd");
    button.disabled = true;
    button.querySelector(".libelle").textContent = "Capture en cours…";
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
      await fontReady();
      drawCartouches(ctx, canvas, Math.max(14, Math.round(canvas.height / 54)), params.caption, placeText());
      await save(await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92)));
    } catch (error) {
      setStatus(`Capture « Image seule » impossible : ${error.message}`, "echec");
    } finally {
      button.disabled = !photo || !Calcul.hasWorker();  // photo fermée pendant la capture : reste inactif
      button.querySelector(".libelle").textContent = "Image seule";
    }
  });

  $("#vignette").addEventListener("click", async () => {
    if (!psv) return;
    try {
      const date = (photo?.properties?.datetime || "").replace(/[^0-9]/g, "").slice(0, 8) || "sansdate";
      const save = await saveAs(`panoramax_vignette_${date}_${(photo?.id || "").slice(0, 8)}.png`, "image/png");
      if (!save) return;
      await fontReady();
      const canvas = thumbnail();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      await save(blob);
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

  // Fiche PDF d'un point de référence ---------------------------------------------------------
  // Une page A4 : photo de la visionneuse en pleine largeur, cadrée sur la plus grande mesure du
  // point (10 % de marge), puis ses résultats et la méthode à côté de la mini-carte. Fenêtre à
  // part, imprimée par le navigateur (« Enregistrer au format PDF »).
  const FICHE_PHOTO = { width: 698, height: 356 }, FICHE_MAP = { width: 230, height: 300 };
  // Polices de la page (Inter, JetBrains Mono), pour la fenêtre de la fiche, document à part
  const FICHE_FONTS = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/latin-400.css"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/latin-500.css"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/latin-700.css"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.3.0/latin-400.css">';
  const FICHE_UNZOOM = 10;  // largeur : niveaux de zoom ôtés après le cadrage, 2 crans de molette (5 chacun)

  /** Image (data: JPEG) d'une zone du canevas source au rapport largeur / hauteur aspect, de size px de
   * large au plus (sinon la plus grande possible), centrée sur center ([x, y] px du canevas, gardée
   * dedans), par défaut sur le milieu. */
  function cropCenter(source, aspect, size = Infinity, center = null) {
    let w = Math.min(source.width, size), h = source.height;
    if (w / h > aspect) w = Math.round(h * aspect);
    else h = Math.round(w / aspect);
    const [cx, cy] = center || [source.width / 2, source.height / 2];
    const left = Math.max(0, Math.min(source.width - w, cx - w / 2)), top = Math.max(0, Math.min(source.height - h, cy - h / 2));
    const out = Object.assign(document.createElement("canvas"), { width: w, height: h });
    out.getContext("2d").drawImage(source, left, top, w, h, 0, 0, w, h);
    return out.toDataURL("image/jpeg", 0.9);
  }

  /** Cône de la vue de la photo (comme Carte.showView, élément HTML hors de l'image WebGL de la
   * carte) dessiné sur ctx : sommet à la photo, ouverture fov, rayon 70 px écran ; carte au nord. */
  function drawViewCone(ctx, scale) {
    const heading = viewHeading();
    if (!photo || heading == null) return;
    const p = map.project(photo.geometry.coordinates), x = p.x * scale, y = p.y * scale, r = 70 * scale;
    const half = Math.min(viewFov(), 170) / 2, rad = (d) => ((d - 90) * Math.PI) / 180;
    ctx.save();
    ctx.fillStyle = "rgba(0, 120, 255, 0.25)";
    ctx.strokeStyle = "#0078ff";
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, rad(heading - half), rad(heading + half));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Croix bleue liserée de blanc, tournée avec la vue, comme sur la mini-carte (Carte.showView)
    ctx.translate(x, y);
    ctx.rotate(heading * Math.PI / 180);
    ctx.lineCap = "round";
    for (const [color, width] of [["#ffffff", 6], ["#0078ff", 3]]) {
      ctx.beginPath();
      ctx.moveTo(-8 * scale, 0);
      ctx.lineTo(8 * scale, 0);
      ctx.moveTo(0, -8 * scale);
      ctx.lineTo(0, 8 * scale);
      ctx.strokeStyle = color;
      ctx.lineWidth = width * scale;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Mini-carte centrée sur bounds ([[lon, lat], [lon, lat]]) au zoom choisi dans la page, en image à
   * la même échelle (FICHE_MAP px d'écran), avec le cône de vue ; null si elle est repliée, ou si le
   * fond refuse d'être lu (CORS). La vue de la carte est remise comme avant. */
  async function mapSnapshot(bounds, asShown = false) {  // asShown : sans la recentrer sur bounds
    const canvas = map.getCanvas();
    if (!canvas.clientWidth || !canvas.clientHeight) return null;
    const before = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing() };
    try {
      const [[w, south], [e, north]] = bounds;
      if (!asShown) map.jumpTo({ center: [(w + e) / 2, (south + north) / 2], zoom: before.zoom, bearing: 0 });
      // carte déjà immobile (vue actuelle, sans jumpTo) : « idle » ne viendrait plus, 8 s d'attente pour rien
      if (!asShown || !map.loaded()) await Promise.race([new Promise((resolve) => map.once("idle", resolve)), new Promise((r) => setTimeout(r, 8000))]);
      return await new Promise((resolve) => {  // image WebGL lue juste après son rendu
        map.once("render", () => {
          try {
            const copy = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height });
            const ctx = copy.getContext("2d");
            ctx.drawImage(canvas, 0, 0);
            drawViewCone(ctx, canvas.width / canvas.clientWidth);
            drawScreenLabels(ctx, map.getContainer(), canvas.getBoundingClientRect(), canvas.width / canvas.clientWidth);
            resolve(cropCenter(copy, FICHE_MAP.width / FICHE_MAP.height, FICHE_MAP.width * canvas.width / canvas.clientWidth));
          } catch { resolve(null); }
        });
        map.triggerRepaint();
      });
    } finally {
      map.jumpTo(before);
    }
  }

  /** Choix de la photo de la fiche (cadrage automatique ou vue actuelle), puis la fiche : la fenêtre
   * s'ouvre au clic du choix, geste de l'utilisateur (sinon bloquée par le navigateur). */
  // k : n° du point de référence, ou { objet : n° de l'objet de la couche } (clic droit dans la photo),
  // ou { tous : true } (bouton de la couche : tous ses objets, en cadrage automatique seulement)
  function askFiche(k, text) {
    const dialog = $("#choix-fiche"), layered = typeof k === "object", all = Boolean(k?.tous);
    const n = overlay?.features.length;
    const name = all ? "" : layered ? overlayObjectName(k.objet) : (/^Point (\S+)/.exec(text) || [])[1] || "";
    dialog.querySelector("h2").firstChild.textContent = all ? `Fiches des ${n} objet${n > 1 ? "s" : ""} de la couche`
      : layered ? "Fiche de l'objet " : "Fiche du point ";
    dialog.querySelector("h2 span").textContent = name;
    // tous les objets : « Cadrage type », réglé sur le 1er (zoom, élévation) puis repris pour chacun
    dialog.querySelector(".vue-actuelle").textContent = all ? "Cadrage type…" : "Vue actuelle";
    dialog.querySelector(".fiche-point").hidden = layered;
    for (const el of dialog.querySelectorAll(".fiche-objet")) el.hidden = !layered;
    // texte libre, laissé tel quel ou modifié
    $("#titre-fiche").value = all ? overlay.name : layered ? `${overlay.name}, objet ${name}` : `point de référence ${name}`;
    if (layered) showFicheFields();
    dialog.querySelector(".fiche-tous").hidden = !all;
    if (all) showFicheObjects();
    else for (const b of dialog.querySelectorAll(".vue-actuelle, .cadrage-auto")) b.disabled = false;
    const frame = all ? null : showFicheFrame();
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (!dialog.returnValue) return dropFrame(frame);
      if (layered) {  // choix gardés avec la couche, pour la fiche des objets suivants
        overlay.fiche = [...$("#fiche-champs").children].map((li) => [li.dataset.champ, li.querySelector("input").checked]);
        saveOverlay();
        k = { ...k, champs: overlay.fiche.filter(([, on]) => on).map(([c]) => c) };
      }
      const title = $("#titre-fiche").value.trim();
      const ids = all ? [...$("#fiche-objets").querySelectorAll("input:checked")].map((box) => Number(box.value)) : [];
      if (all) return dialog.returnValue === "auto" ? makeFiches(ids, k.champs, title) : modelFiche(ids, k.champs, title)
        .catch((error) => setStatus(`Fiches impossibles : ${error.message}`, "echec"));
      if (dialog.returnValue === "auto" || !frame) {
        dropFrame(frame);
        return makeFiche(k, dialog.returnValue === "auto", title);
      }
      reframeFiche(frame, () => makeFiche(k, false, title));  // vue actuelle : recadrée d'abord
    }, { once: true });
    showOverViewer(dialog);
  }

  /** « Cadrage type » des fiches de tous les objets : photo du 1er objet ouverte et cadrée dessus ; zoom, élévation et
   * photo (tant de photos avant ou après la sienne dans la séquence) choisis par l'utilisateur (reframeFiche), puis
   * repris pour chaque objet, cap tourné vers lui (makeFiches). */
  async function modelFiche(ids, champs, title) {
    const first = await overlayFicheData(ids[0], null, true);
    if (first.photo && photo?.id !== first.photo) await openPhotoReady(first.photo);
    frameView(overlayEnds(ids[0]));
    reframeFiche(showFicheFrame(), () => {  // photo choisie lue dans la visionneuse (flèches comprises)
      makeFiches(ids, champs, title, { pitch: psv.getPosition().pitch, zoom: psv.getZoomLevel(), chosen: psv.getPictureMetadata?.()?.id || photo?.id });
    });
    setStatus(`Cadrage type sur l'objet ${overlayObjectName(ids[0])} : réglez le zoom et la hauteur de vue (molette, glisser), `
      + "changez de photo dans la séquence si besoin ; repris pour tous les objets, le cap tourné vers chacun. "
      + "Puis « Valider le cadrage » (Échap pour annuler).");
  }

  /** Identifiant de la photo offset rangs plus loin que la photo id dans sa séquence (lue comme la lecture rapide,
   * loadRanks) ; id elle-même au-delà du début ou de la fin de la séquence, ou si elle est illisible. */
  async function photoAtOffset(id, offset) {
    if (!offset || !id) return id;
    const f = await Carte.photoById(id).catch(() => null);
    const rank = Number(f?.properties?.["geovisio:rank_in_collection"]), apis = f?.collection ? sequenceApis(f) : [];
    if (!Number.isInteger(rank) || !apis.length) return id;
    const run = { apis, ids: new Map(), step: offset };
    await loadRanks(run, rank + offset).catch(() => null);
    return run.ids.get(rank + offset) || id;
  }

  /** « Vue actuelle » : fenêtre fermée, la vue se recadre dans la visionneuse (glisser, molette) sous le cadre
   * de la fiche, puis « Valider le cadrage » lance la fiche (go) ; « Annuler » ou Échap y renoncent. */
  function reframeFiche(frame, go) {
    const bar = Object.assign(document.createElement("div"), { className: "cadre-boutons" });
    const button = (text, cls, action) => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, className: cls });
      b.addEventListener("click", () => { end(); action(); });
      return b;
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      end();
    };
    const end = () => {
      dropFrame(frame);
      document.removeEventListener("keydown", onKey, true);
    };
    bar.append(button("Annuler", "non", () => setStatus("Fiche annulée.")), button("✔ Valider le cadrage", "oui", go));
    frame.append(bar);
    const below = frame.offsetHeight - (frame.firstChild.offsetTop + frame.firstChild.offsetHeight);
    if (below >= 56) Object.assign(bar.style, { bottom: "auto", top: `${frame.offsetHeight - below + 10}px` });  // sous le cadre
    document.addEventListener("keydown", onKey, true);
    setStatus("Fiche : recadrez la vue dans la visionneuse et la mini-carte (glisser, molette) ; seul l'intérieur des cadres "
      + "sera repris. Puis « Valider le cadrage » (Échap pour annuler).");
  }

  /** Cadre de la photo que retiendrait « Vue actuelle » (cropCenter de la vue entière, au format de la
   * photo de la fiche), tracé sur la visionneuse, le reste assombri ; à retirer (remove) à la fermeture. */
  // Aussi sur la mini-carte (frame.linked) : le centre de sa capture (mapSnapshot), à l'échelle de l'écran
  function showFicheFrame() {
    const clip = frameOver(psv?.container, FICHE_PHOTO.width / FICHE_PHOTO.height, Infinity, "Cadre de la fiche (vue actuelle)");
    if (clip && !mapBox.hidden) clip.linked = frameOver(map.getCanvas(), FICHE_MAP.width / FICHE_MAP.height, FICHE_MAP.width, "Fiche");
    return clip;
  }

  /** Cadre centré sur element (dans son document : carte détachée comprise), comme cropCenter : au format
   * aspect, size px de large au plus ; le reste assombri. null si element n'est pas affiché. */
  function frameOver(element, aspect, size, text) {
    const box = element?.getBoundingClientRect();
    if (!box?.width || !box.height) return null;
    let w = Math.min(box.width, size), h = box.height;
    if (w / h > aspect) w = h * aspect;
    else h = w / aspect;
    const doc = element.ownerDocument;
    const clip = Object.assign(doc.createElement("div"), { className: "cadre-fiche" });
    Object.assign(clip.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    const inner = doc.createElement("div");
    Object.assign(inner.style, { left: `${(box.width - w) / 2}px`, top: `${(box.height - h) / 2}px`, width: `${w}px`, height: `${h}px` });
    inner.append(Object.assign(doc.createElement("span"), { textContent: text }));
    clip.append(inner);
    doc.body.append(clip);
    return clip;
  }
  const dropFrame = (frame) => { frame?.linked?.remove(); frame?.remove(); };

  /** Données de la fiche d'un objet de la couche : cases et ordre (↑ ↓, ou glissé-déposé) gardés avec la couche (overlay.fiche,
   * [[colonne, cochée]]), puis les colonnes apparues depuis, cochées ; sans les colonnes techniques d'un relevé. */
  function showFicheFields() {
    const columns = overlay.columns.filter((c) => !(overlay.techniques || []).includes(c));
    const kept = (overlay.fiche || []).filter(([c]) => columns.includes(c));
    const list = [...kept, ...columns.filter((c) => !kept.some(([k]) => k === c)).map((c) => [c, true])];
    const ol = $("#fiche-champs");
    const arrows = () => [...ol.children].forEach((li, i, all) => {  // grisées aux bouts de la liste
      li.querySelector(".monter").disabled = i === 0;
      li.querySelector(".descendre").disabled = i === all.length - 1;
    });
    let dragged = null;  // ligne glissée : elle se place au-dessus ou au-dessous de celle survolée
    ol.replaceChildren(...list.map(([column, on]) => {
      const li = Object.assign(document.createElement("li"), { draggable: true, title: "Glisser pour déplacer" });
      li.dataset.champ = column;
      li.addEventListener("dragstart", (event) => {
        dragged = li;
        li.classList.add("glisse");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", column);  // Firefox : sans données, pas de glissé
      });
      li.addEventListener("dragover", (event) => {
        if (!dragged || dragged === li) return;
        event.preventDefault();
        const box = li.getBoundingClientRect();
        if (event.clientY < box.top + box.height / 2) li.before(dragged);
        else li.after(dragged);
      });
      li.addEventListener("drop", (event) => event.preventDefault());
      li.addEventListener("dragend", () => {
        li.classList.remove("glisse");
        dragged = null;
        arrows();
      });
      const grip = Object.assign(document.createElement("span"), { className: "poignee", textContent: "≡" });
      grip.setAttribute("aria-hidden", "true");
      li.append(grip);
      const label = document.createElement("label");
      label.append(Object.assign(document.createElement("input"), { type: "checkbox", checked: on }), column);
      const button = (text, cls, title, move) => {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, className: cls, title });
        b.setAttribute("aria-label", `${title} : ${column}`);
        b.addEventListener("click", () => { move(); arrows(); b.disabled || b.focus(); });
        return b;
      };
      li.append(label, button("↑", "monter", "Monter", () => li.previousElementSibling?.before(li)),
        button("↓", "descendre", "Descendre", () => li.nextElementSibling?.after(li)));
      return li;
    }));
    arrows();
  }

  /** Objets retenus pour les fiches de tous les objets : cochés sauf ceux masqués dans la légende ; boutons de la
   * fenêtre grisés sans objet retenu. */
  function showFicheObjects() {
    const ol = $("#fiche-objets"), masked = overlayMasked();
    const buttons = $("#choix-fiche").querySelectorAll(".vue-actuelle, .cadrage-auto");
    const count = () => {
      const on = ol.querySelectorAll("input:checked").length;
      $("#fiche-objets-nombre").textContent = `${on} / ${ol.children.length}`;
      for (const b of buttons) b.disabled = !on;
      $("#fiche-objets-tous").disabled = on === ol.children.length;
      $("#fiche-objets-aucun").disabled = !on;
    };
    ol.replaceChildren(...overlay.features.map((f, id) => {
      const li = document.createElement("li"), label = document.createElement("label");
      const box = Object.assign(document.createElement("input"), { type: "checkbox", value: id, checked: !masked.has(f.properties._cle) });
      box.addEventListener("change", count);
      const name = overlayObjectName(id);  // rang affiché quand le nom ne le donne pas (plage « Du … au … »)
      label.append(box, name === String(id + 1) ? `Objet ${name}` : `${id + 1}. Objet ${name}`);
      li.append(label);
      return li;
    }));
    const all = (on) => { for (const box of ol.querySelectorAll("input")) box.checked = on; count(); };
    $("#fiche-objets-tous").onclick = () => all(true);
    $("#fiche-objets-aucun").onclick = () => all(false);
    const from = $("#fiche-objets-de"), to = $("#fiche-objets-a");
    from.max = to.max = ol.children.length;
    [from.value, to.value] = [1, ol.children.length];
    const range = () => {  // grisé tant que la plage n'est pas valable
      const [a, b] = [Number(from.value), Number(to.value)];
      $("#fiche-objets-plage").disabled = !(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= b && b <= ol.children.length);
    };
    from.oninput = to.oninput = range;
    $("#fiche-objets-plage").onclick = () => {
      ol.querySelectorAll("input").forEach((box, i) => { box.checked = i + 1 >= Number(from.value) && i + 1 <= Number(to.value); });
      count();
    };
    range();
    count();
  }

  // build(step) : HTML de la fiche ; par défaut, celle de k (buildFiche) ; counted : pourcentage donné par build seul,
  // sans décompte fictif (fiches de plusieurs objets : part des fiches déjà faites)
  async function makeFiche(k, auto = true, title = "", build = (step) => buildFiche(k, auto, title, step), counted = false) {
    if (!app || !psv) return;
    // Ouverte tout de suite (après une attente, bloquée), en petite fenêtre à part : dans un onglet, la page
    // passerait en arrière-plan, où Chrome et Edge arrêtent requestAnimationFrame et la capture attendrait
    const win = window.open("", "_blank", "popup,width=520,height=420");
    if (!win) {
      setStatus("Fiche : fenêtre bloquée par le navigateur (autorisez les fenêtres de cette page).", "echec");
      return;
    }
    win.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiche — préparation</title>${FICHE_FONTS}<style>
body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
  font-family: Inter, Arial, sans-serif; color: #1c1c1c; background: #f5f5f3; }
.cercle { position: relative; width: 78px; height: 78px; }
.roue { position: absolute; inset: 0; border: 7px solid #ffd8bf; border-top-color: #e65100; border-radius: 50%; animation: tour 0.9s linear infinite; }
#pourcent { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 700; color: #e65100; }
@keyframes tour { to { transform: rotate(360deg); } }
h1 { margin: 0; font-size: 28px; } #etape { font-size: 17px; color: #444; min-height: 1.4em; }
p.aide { margin: 0; font-size: 14px; color: #555; }
@media (prefers-reduced-motion: reduce) { .roue { animation-duration: 3s; } }
</style></head><body><div class="cercle"><div class="roue"></div><div id="pourcent" role="progressbar" aria-label="Préparation en cours" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">0 %</div></div>
<h1>Préparation de la fiche…</h1><div id="etape" aria-live="polite">Ouverture de la photo de la mesure</div>
<p class="aide">Quelques secondes : la photo est cadrée et capturée, puis la boîte d'impression s'ouvre.</p></body></html>`);
    win.document.close();
    let tick = null;
    try {
      // Pourcentage : décompte fictif de 5 % toutes les 2 s (95 % au plus), remonté sur chaque étape
      // atteinte en avance sur lui (jamais redescendu)
      let percent = 0;
      const show = (value) => {
        percent = value;
        const bar = win.document.getElementById("pourcent");
        bar?.replaceChildren(`${value} %`);
        bar?.setAttribute("aria-valuenow", String(value));
      };
      if (!counted) tick = setInterval(() => show(Math.min(95, percent + 5)), 2000);
      const html = await build((text, value) => {
        const step = win.document.getElementById("etape");
        if (step) step.textContent = text;
        show(Math.max(percent, value));
      });
      clearInterval(tick);
      win.document.open();
      win.document.write(html);
      win.document.close();
      await Promise.all([...win.document.images].map((img) => img.decode().catch(() => null)));
      await win.document.fonts.ready;  // hauteurs définitives avant le découpage
      for (const page of [...win.document.querySelectorAll(".page")]) paginateFiche(win.document, page);
      win.resizeTo(Math.min(900, screen.availWidth), screen.availHeight);  // la fiche entière, à lire avant d'imprimer
      win.focus();
      win.print();
    } catch (error) {
      win.document.body.textContent = `Fiche impossible : ${error.message}`;
    } finally {
      clearInterval(tick);
    }
  }

  /** Fiches des objets ids de la couche (retenus dans askFiche) en un seul document, une page chacun (et ses suites), en
   * cadrage automatique, ou type (view : { pitch, zoom, chosen }, voir modelFiche) ; champs : données choisies (askFiche),
   * title : celui de la couche. Toutes les photos d'une même séquence : celle de la photo choisie (cadrage type), sinon
   * celle de la photo du 1er objet retenu ; chaque objet sur la plus proche de cette séquence, décalée comme la photo choisie
   * l'est de celle du 1er objet. */
  function makeFiches(ids, champs, title, view = true) {
    return makeFiche(null, true, title, async (step) => {  // lu ici : la fenêtre s'ouvre d'abord, au clic
      step("Séquence des photos", 0);
      const read = (id) => (id ? Carte.photoById(id).catch(() => null) : null);
      const rank = (f) => Number(f?.properties?.["geovisio:rank_in_collection"]);
      // Rangs relus dans l'API : la fiche d'une photo atteinte par les flèches de la visionneuse peut ne pas les avoir
      const chosen = await read(view.chosen);
      const seq = chosen?.collection || (await read((await overlayFicheData(ids[0], null, true)).photo))?.collection || null;
      if (chosen) {
        const base = await read((await overlayFicheData(ids[0], null, true, seq)).photo);
        view = { ...view, offset: base?.collection === seq ? rank(chosen) - rank(base) || 0 : 0 };
      }
      let doc = null;
      const n = ids.length, missed = [];
      for (const [i, id] of ids.entries()) {
        const name = overlayObjectName(id);
        try {
          // own : la photo de chaque objet, pas celle affichée (où des objets proches seraient tous dessinés)
          const html = await buildFiche({ objet: id, champs, own: true, seq }, view, `${title || overlay.name}, objet ${name}`,
            (text) => step(`Objet ${name} (${i + 1} / ${n}) : ${text.toLowerCase()}`, Math.round(i / n * 100)));
          const page = new DOMParser().parseFromString(html, "text/html");
          if (doc) doc.body.append(page.querySelector(".page"));
          else doc = page;
        } catch (error) {  // objet sans fiche : les suivants quand même, puis la liste
          console.warn(`Fiche de l'objet ${name} :`, error);
          missed.push(`${name} (${error.message})`);
        }
        step(`${i + 1} fiche${i ? "s" : ""} sur ${n}`, Math.round((i + 1) / n * 100));
      }
      if (missed.length) {
        setStatus(`Fiches : ${missed.length} objet${missed.length > 1 ? "s" : ""} sans fiche : ${missed.join(" ; ")}.`, "echec");
      }
      if (!doc) throw new Error(`aucun objet n'a pu avoir sa fiche (${missed[0] || "couche vide"})`);
      return `<!doctype html>${doc.documentElement.outerHTML}`;
    }, true);
  }

  /** Vue de la visionneuse immobile (cap, élévation, zoom) depuis 400 ms, ses tuiles chargées, et redessinée : la
   * capture ne part ni pendant le mouvement de cadrage, ni sur une image encore floue ou incomplète (réseau lent).
   * 8 s au plus pour le mouvement, 20 s pour les tuiles. */
  async function viewSettled() {
    const key = () => { const p = psv.getPosition(); return [p.yaw, p.pitch, psv.getZoomLevel()].map((v) => v.toFixed(5)).join(); };
    let last = key(), since = Date.now();
    for (const t0 = Date.now(); Date.now() - t0 < 8000 && Date.now() - since < 400;) {
      await new Promise((r) => setTimeout(r, 100));
      const now = key();
      if (now !== last) [last, since] = [now, Date.now()];
    }
    // File des tuiles vide deux fois de suite (comme l'événement « picture-tiles-loaded » de la visionneuse)
    for (let t0 = Date.now(), empty = 0; empty < 2 && Date.now() - t0 < 20000;) {
      await new Promise((r) => setTimeout(r, 100));
      empty = Object.keys(psv.adapter?.queue?.tasks || {}).length ? 0 : empty + 1;
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));  // image et repères à jour
  }

  /** Page de la fiche du point gardé n° k (HTML complet) : photo d'où sa plus grande mesure a été prise ouverte et
   * cadrée, puis capturée avec la mini-carte. */
  // auto : photo de la mesure, cadrée dessus ; { pitch, zoom, offset } (makeFiches) : de même, mais cadrage type (élévation et zoom
  // donnés, cap tourné vers l'objet, photo offset rangs plus loin dans la séquence) ; sinon la vue actuelle telle qu'affichée.
  // step(texte, %) : étape en cours, pour la fenêtre d'attente
  async function buildFiche(k, auto = true, title = "", step = () => {}) {  // title : après « Fiche de mesure — »
    const layered = typeof k === "object";  // objet de la couche (voir askFiche)
    const data = layered ? await overlayFicheData(k.objet, k.champs, k.own, k.seq) : JSON.parse(app.fiche(k));
    data.title = title || `point de référence ${data.name}`;
    if (!auto) data.photo = photo?.id || data.photo;  // pied de la fiche : la photo capturée
    if (auto?.offset) data.photo = await photoAtOffset(data.photo, auto.offset);  // cadrage type : même décalage dans la séquence
    step(auto ? "Ouverture de la photo de la mesure" : "Capture de la vue actuelle", 0);
    // Photo d'où la plus grande mesure a été prise (objet : la sienne) ; comparée à celle de la visionneuse, pas à la fiche
    // gardée (photo), qui peut retarder sur elle
    const shown = () => psv.getPictureMetadata?.()?.id;
    if (auto && data.photo && shown() !== data.photo) await openPhotoReady(data.photo);
    if (k.own && (!data.photo || shown() !== data.photo)) {  // fiches de tous les objets : jamais sur la photo d'un autre
      throw new Error(data.photo ? `photo ${data.photo} non ouverte` : "aucune photo trouvée près de l'objet (filtre, instance ?)");
    }
    step(auto ? "Cadrage de la photo sur la mesure" : "Capture de la vue actuelle", 40);
    const ends = !auto ? [] : layered ? overlayEnds(k.objet) : JSON.parse(app.fiche_frame(k));
    // Hauteur : la mesure sur 75 % de la hauteur de l'image ; largeur : 10 % de marge de chaque côté ;
    // objet de la couche : centré, champ de vue d'un point seul
    if (auto?.zoom !== undefined && ends.length) {
      psv.rotate({ yaw: ends[0][0], pitch: auto.pitch });
      psv.zoom(auto.zoom);
    } else frameView(ends, false, layered ? null : { aspect: FICHE_PHOTO.width / FICHE_PHOTO.height, margin: data.kind === "height" ? 1 / 0.75 : 1.25 });
    await viewSettled();
    if (auto && !layered && data.kind !== "height") {  // largeur : un peu de recul autour de la ligne ; hauteur : cadrage seul
      psv.zoom(Math.max(0, psv.getZoomLevel() - FICHE_UNZOOM));
      await viewSettled();
    }
    for (let t = 0; t < 20 && !placeText(); t++) await new Promise((r) => setTimeout(r, 250));  // lieu (route, PR) lu
    await fontReady();
    // Recadrée autour de la mesure : au bord de la photo, la vue ne peut pas se centrer dessus
    const view = thumbnail(), scale = view.width / psv.container.clientWidth;
    const xy = ends.map(([yaw, pitch]) => psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch }));
    const center = xy.length ? [xy.reduce((t, p) => t + p.x, 0) / xy.length * scale, xy.reduce((t, p) => t + p.y, 0) / xy.length * scale] : null;
    const picture = cropCenter(view, FICHE_PHOTO.width / FICHE_PHOTO.height, Infinity, center);
    step("Capture de la mini-carte", 75);
    if (layered && photo) {  // l'objet et la photo de la fiche
      const [lon, lat] = photo.geometry.coordinates;
      data.bounds = [[Math.min(lon, data.lon), Math.min(lat, data.lat)], [Math.max(lon, data.lon), Math.max(lat, data.lat)]];
    }
    const mapImage = await mapSnapshot(data.bounds, !auto);  // vue actuelle : la carte telle que recadrée
    step("Mise en page", 95);
    if (photo) data.place = (await Lieu.describe(...photo.geometry.coordinates.slice(0, 2)).catch(() => ({}))).parts;  // déjà lu : sans requête
    // Sur un pont : son nom (sans la route, déjà écrite) et ce qu'il franchit, sans la hauteur de chute
    const onBridge = JSON.parse(app.fall_json());
    const [bridge, ...more] = (onBridge?.edges ? "" : onBridge?.text || "").split("\n");
    data.bridge = bridge ? [bridge.replace(/\s*\([^)]*\)$/, ""), more.find((t) => t.startsWith("Au-dessus"))].filter(Boolean) : [];
    return ficheHtml(data, picture, mapImage, JSON.parse(app.state()));
  }

  /** Fond de la mini-carte pour la fiche : nom officiel de la couche (titre publié par la Géoplateforme,
   * couche affichée pour l'ortho-express et le PCRS) et producteur. */
  function backgroundName() {
    const value = $("#fond").value;
    if (value === "osm") return "OpenStreetMap France (contributeurs d'OpenStreetMap)";
    const layer = (/LAYER=([^&]+)/.exec(map.getStyle()?.sources?.[value]?.tiles?.[0] || "") || [])[1] || "";
    const year = (/EXPRESS\.(\d{4})/.exec(layer) || [])[1];
    const name = value === "plan" ? "Plan IGN"
      : value === "express" && year ? `Ortho-express ${Number(year) >= 2025 ? "RVB " : ""}${year}`
      : value === "pcrs" ? (layer === "PCRS.LAMB93" || !layer ? "PCRS" : layer)
      : value === "mnh" ? "Modèle Numérique de Hauteur LiDAR HD"
      : "Photographies aériennes";  // orthophoto, avec ou sans noms
    return `${name} (IGN)`;
  }

  /** Page de la fiche (voir la maquette du 24/10/2026) : HTML complet, styles compris. */
  function ficheHtml(data, picture, mapImage, state) {
    const e = escapeHtml, now = new Date();
    const date = `${now.toLocaleDateString("fr-FR")} · ${now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
    const place = placeText() || "Lieu inconnu";
    const placeHtml = [placeMarkup(place, data.place),  // route et commune en gras, comme dans la visionneuse
      ...data.bridge.map((t, i) => e(i ? t[0].toLowerCase() + t.slice(1) : t))].join(" – ");  // pont, au-dessus de…
    const background = backgroundName();
    const coords = `${data.lat.toFixed(5).replace(".", ",")}° N · ${data.lon.toFixed(5).replace(".", ",")}° E`;
    const api = Carte.apiUrl();
    const link = `${api.replace(/\/api\/?$/, "")}/#focus=pic&pic=${data.photo || photo?.id || ""}`;
    let qrSvg = "";  // lien vers la photo en QR code (bibliothèque qrcode-generator ; sans elle, pas de QR)
    try {
      const qr = qrcode(0, "M");
      qr.addData(link);
      qr.make();
      qrSvg = qr.createSvgTag(2, 0);
    } catch { /* bibliothèque non chargée */ }
    // Objet de la couche : ses attributs ; sinon les points (A, puis le point d'arrivée de chaque mesure),
    // la mesure en gras sur sa ligne, dessous
    const table = data.attributes
      ? `<thead><tr><th>Champ</th><th>Valeur</th></tr></thead><tbody>${data.attributes.map(([k, v]) =>
        `<tr><td class='pt'>${e(k)}</td><td>${e(Couche.format(v))}</td></tr>`).join("")}</tbody>`
      : null;
    const rows = data.rows.map((r) => `<tr class='${r.kind}'><td class='pt'>${e(r.point)}</td><td>${e(r.mesure)}</td>`
      + `<td class='num'>${e(r.valeur || "—")}</td><td class='num'>${e(r.incert || "—")}</td><td class='com'>${e(r.commentaire || "")}</td></tr>`).join("");
    // Position de la photo, puis une ligne courte par mesure
    // (sans l'état de l'inclinaison ni son alerte : position seulement)
    const position = (state.quality || "").replace(/^⚠\s*/, "").split(" · ").filter((t) => !t.startsWith("inclinaison")).join(" · ");
    const lines = [position, ...data.texts].filter(Boolean).map((t) => `<li>${e(t)}</li>`).join("");
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiche ${e(data.name)} — Mesures Panoramax</title>${FICHE_FONTS}
<style>
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, Arial, sans-serif; color: #1c1c1c; background: #fff; }
.page { width: 210mm; height: 297mm; padding: 11.6mm 12.7mm; display: flex; flex-direction: column; gap: 18px; overflow: hidden; }
.page + .page { break-before: page; }  /* suite d'une fiche trop longue (paginateFiche), fiche de l'objet suivant (makeFiches) */
header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #e65100; padding-bottom: 12px; }
h1 { margin: 0; font-size: 26px; letter-spacing: -0.3px; } .sous-titre { font-size: 15px; font-weight: 500; color: #444; margin-top: 4px; }
.date { align-self: center; font-size: 14px; font-weight: 500; }  /* centrée sur la hauteur du titre */
.lieu { font-size: 13px; } .lieu .ou { font-size: 16px; margin-bottom: 3px; } .lieu span { color: #444; }
figure { margin: 0; display: flex; flex-direction: column; gap: 5px; }
figure img { display: block; width: 100%; border-radius: 4px; } figcaption { font-size: 12px; color: #555; text-align: center; }
.bas { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) ${FICHE_MAP.width}px; gap: 24px; align-items: center; }  /* jusqu'au pied : mini-carte centrée dans cette hauteur */
.textes { align-self: start; display: flex; flex-direction: column; gap: 16px; min-width: 0; }  /* tableau sous la photo */
h2 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.6px; color: #e65100; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; font-weight: 500; padding: 5px 6px; border-bottom: 1.5px solid #1c1c1c; }
td { padding: 6px; border-bottom: 1px solid #c8c8c8; vertical-align: top; } tr.point td { background: #f5f5f3; }
tr.mesure td { font-weight: 700; }
td.pt { font-weight: 700; white-space: nowrap; } .num { text-align: right; white-space: nowrap; } td.com { color: #444; }
ul { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.5; }
.carte-vide { height: ${FICHE_MAP.height}px; border: 1.5px dashed #888; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #555; text-align: center; padding: 8px; }
footer { margin-top: auto; border-top: 1px solid #c8c8c8; padding-top: 10px; font-size: 11.5px; color: #444; display: flex; align-items: center; gap: 16px; }
.pied { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; } .qr { flex: none; } .qr svg { display: block; width: 72px; height: 72px; }
footer a { color: #1a56c4; word-break: break-all; } .mono { font-family: "JetBrains Mono", monospace; color: #1c1c1c; }
@media screen { body { background: #888; } .page { margin: 16px auto; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.4); } }
</style></head><body><div class="page">
<header><div><h1>Mesures Panoramax</h1><div class="sous-titre">${data.attributes ? "Fiche d'objet" : "Fiche de mesure"} — ${e(data.title)}</div></div>
<div class="date">${e(date)}</div></header>
<section class="lieu"><div class="ou">${placeHtml}</div><span>${data.attributes ? "Objet" : "Point"} ${e(data.name)} : ${e(coords)}</span></section>
<figure><img src="${picture}" alt="Photo de la mesure, annotée"></figure>
<section class="bas"><div class="textes">
<div><h2>${data.attributes ? "Attributs" : "Résultats"}</h2><table>${table || `<thead><tr><th>Point</th><th>Mesure</th><th class="num">Valeur</th><th class="num">Incertitude</th><th>Commentaire</th></tr></thead><tbody>${rows}</tbody>`}</table></div>
<div><h2>Méthode et précision</h2><ul>${lines}</ul></div></div>
<figure>${mapImage ? `<img src="${mapImage}" alt="Mini-carte : ${data.attributes ? "objet" : "point"} ${e(data.name)}${data.attributes ? "" : " et ses mesures"}">` : "<div class='carte-vide'>Mini-carte indisponible (carte repliée, ou fond illisible)</div>"}
<figcaption>Fond de carte ${e(background)}</figcaption></figure></section>
<footer><div class="pied"><div>Photo <span class="mono">${e(data.photo || "")}</span> · ${e(app.caption(0))} · instance ${e(api)}</div>
<a href="${e(link)}">${e(link)}</a></div>
${qrSvg ? `<div class="qr" title="Photo dans Panoramax">${qrSvg}</div>` : ""}</footer>
</div></body></html>`;
  }

  /** Fiche plus haute qu'une page A4 (ticket #32) : la fin de ses listes (lignes du tableau, puis de
   * « Méthode et précision ») passe sur la page suivante, sous le même en-tête, et ainsi de suite.
   * Jamais une ligne seule d'un côté : au moins deux, sinon la liste entière. */
  function paginateFiche(doc, page = doc.querySelector(".page"), depth = 0) {
    const fits = () => page.scrollHeight <= page.clientHeight;
    if (!page || fits()) return;
    const suite = (el) => el.textContent.endsWith(" (suite)") || el.append(" (suite)");
    const next = doc.createElement("div"), texts = doc.createElement("div");
    next.className = "page suite";
    texts.className = "textes";
    next.append(page.querySelector("header").cloneNode(true), texts);
    suite(next.querySelector(".sous-titre"));
    page.after(next);
    for (const section of [...page.querySelectorAll(".textes > div")].reverse()) {  // de la fin de la page
      const list = section.querySelector("tbody, ul"), rest = section.cloneNode(true);
      const moved = rest.querySelector("tbody, ul");
      moved.replaceChildren();
      texts.prepend(rest);
      while (!fits() && list.children.length) moved.prepend(list.lastElementChild);
      if (moved.children.length === 1 && list.children.length) moved.prepend(list.lastElementChild);
      if (list.children.length < 2) {
        moved.prepend(...list.children);
        section.remove();
      } else if (moved.children.length) suite(rest.querySelector("h2"));
      else rest.remove();
      if (fits()) break;
    }
    if (depth < 9) paginateFiche(doc, next, depth + 1);  // 10 pages au plus par fiche : ligne trop haute
  }

  /** Étiquettes de la couche importée visibles dans root (visionneuse, carte) recopiées sur ctx : même
   * place (origin : rectangle écran de l'image, scale : pixels de l'image par pixel d'écran), texte
   * de la couleur de l'objet, éclaircie de moitié, liseré noir, comme à l'écran. */
  function drawScreenLabels(ctx, root, origin, scale) {
    for (const el of root.querySelectorAll(".etiquette.couche")) {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el);
      if (!r.width || css.visibility === "hidden") continue;
      const [x, y, h] = [(r.left - origin.left) * scale, (r.top - origin.top) * scale, r.height * scale];
      ctx.save();
      ctx.font = `${css.fontWeight} ${parseFloat(css.fontSize) * scale}px ${css.fontFamily}`;
      ctx.textBaseline = "middle";
      Object.assign(ctx, { strokeStyle: "#000", lineWidth: 2 * scale, lineJoin: "round" });
      ctx.fillStyle = css.color;
      const lines = el.textContent.split("\n");  // 2e étiquette : sous la première
      lines.forEach((text, i) => {
        const ly = y + h * (i + 0.5) / lines.length;
        ctx.strokeText(text, x, ly);
        ctx.fillText(text, x, ly);
      });
      ctx.restore();
    }
  }

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
    // Couche importée affichée, sous tout le reste : traits et pastilles de sa couleur, puis ses
    // étiquettes visibles, prises à l'écran (écartées, masquées : comme dans la visionneuse)
    if (overlay && app && $("#couche-visible").checked) {
      const masked = overlayMasked();
      for (const o of JSON.parse(app.overlay_marks())) {
        const f = overlay.features[o.id];
        if (masked.has(f?.properties._cle)) continue;  // valeur masquée dans la légende
        const { kind, pts: views } = overlayPoints(o);  // comme dans la visionneuse (drawViewerMarks)
        const color = f?.properties._couleur || "#66cc66", pts = views.map(screen);
        ctx.save();
        if (kind === "ligne") {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.5 * scale;
          ctx.beginPath();
          let open = false;
          for (const p of pts) {
            if (p && open) ctx.lineTo(...p);
            else if (p) ctx.moveTo(...p);
            open = !!p;
          }
          ctx.stroke();
        } else if (pts[0]) {
          ctx.fillStyle = color;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2 * scale;
          ctx.beginPath();
          ctx.arc(...pts[0], 5.5 * scale, 0, 2 * Math.PI);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
      drawScreenLabels(ctx, psv.container, gl.getBoundingClientRect(), scale);
    }
    // Mesures : la surcouche WebGL de la visionneuse (traits, croix, étiquettes), telle qu'affichée
    const layer = Traits.snapshot();
    if (layer?.width) ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
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
      ctx.font = `500 ${s}px Inter, system-ui, sans-serif`;
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

  /** Police Inter chargée, pour le texte dessiné dans les captures (sinon police de repli). */
  function fontReady() {
    return document.fonts ? document.fonts.load("500 12px Inter").catch(() => {}) : Promise.resolve();
  }

  /** Localisation affichée dans la visionneuse (route, PR, commune), ou "". */
  function placeText() {
    return $("#lieu").hidden ? "" : $("#lieu").textContent;
  }

  /** Étiquette d'une capture, dans le style de l'étiquette de localisation de la visionneuse
   * (#lieu : fond sombre semi-transparent, angles arrondis, texte blanc Inter moyen détouré),
   * ses dimensions rapportées à la taille du texte (13 px dans la visionneuse). (x, y) : bas
   * de l'étiquette, à gauche, à droite ou au centre selon align. */
  function cartouche(ctx, text, x, y, size, align) {
    ctx.font = `500 ${size}px Inter, system-ui, sans-serif`;
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

  // Pour les essais depuis la console : window.mesures.app.click(yaw, pitch)
  window.mesures = { get app() { return app; }, get psv() { return psv; }, get tourViews() { return tourViews; }, get videoPlan() { return videoPlan; }, get touring() { return Boolean(tour); }, map, openPhoto, buildFiche, paginateFiche, photoAtOffset, importOverlay, thumbnail,
    overlayFile: (handle) => { overlay.fichier = handle; } };  // fichier de la couche remplacé (essais)
})();
