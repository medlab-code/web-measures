// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Page de mesure : la carte choisit la photo, la visionneuse Panoramax reçoit les clics, le cœur
// de calcul Python (py/, exécuté par Pyodide, voir calcul.js) fait les mesures et les calages.

(() => {
  const $ = (selector) => document.querySelector(selector);
  // Captures et fiches PDF (src/fiche.js), branchées sur la page en fin de fichier (Fiche.init)
  const { askFiche, buildFiche, paginateFiche, photoAtOffset, thumbnail, FICHE_FONTS } = Fiche;

  // Site de la branche dev (second Worker) : même code que main, seul le nom d'hôte les distingue
  if (location.hostname.startsWith("web-measures-dev.")) {
    $(".essai").insertAdjacentHTML("afterend", '<span class="branche">Branche expérimentale</span>');
    $('link[rel="icon"]').href = "src/favicon-dev.svg";
  }

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
  // Requêtes GET aux API Panoramax et à la Géoplateforme : RETRY_TIMEOUT ms au plus chacune, reprises jusqu'à RETRIES
  // fois après une panne réseau, un délai dépassé ou une erreur 5xx (pause de 1, 2, puis 4 s) : un service lent ou
  // en panne passagère ne fait plus échouer la préparation d'une vidéo. Les refus en rafale (429) restent à chaque
  // appelant (quotas de la Géoplateforme) ; une requête annulée par la page n'est pas reprise.
  const RETRIES = 3, RETRY_TIMEOUT = 20000;
  async function patientFetch(input, init) {
    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(RETRY_TIMEOUT), ...(init?.signal ? [init.signal] : [])];
      try {
        const response = await nativeFetch(input, { ...init, signal: AbortSignal.any(signals) });
        if (response.status < 500 || attempt === RETRIES) return response;
      } catch (error) {
        if (init?.signal?.aborted || attempt === RETRIES) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      if (init?.signal?.aborted) throw init.signal.reason;
    }
  }
  const trackedFetch = (input, init) => {
    const name = serviceName(input?.url ?? String(input));
    if (!name) return nativeFetch(input, init);
    const timer = setTimeout(() => markService(name, true), SILENT_AFTER);
    // no-store : vérification d'accès, réponse immédiate
    const patient = typeof input === "string" && (init?.method || "GET") === "GET" && init?.cache !== "no-store"
      && (name.startsWith("Panoramax") || /^(IGN|Géoplateforme)/.test(name));
    return (patient ? patientFetch(input, init) : nativeFetch(input, init)).then((response) => {
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
  const CACHE_MAX = 500e6;  // octets : au-delà, les réponses les plus anciennes sont supprimées
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
  const map = Carte.createMap("carte", { vectorPlan: true });  // Plan IGN vectoriel : texte net à tout zoom
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
    set(key, value) {  // false : pas écrit (sans stockage, ou stockage plein)
      try {
        localStorage.setItem(`web-measures/${key}`, value);
        return true;
      } catch {
        return false;
      }
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
  // Couche, Vidéo, Parcours) ou les outils du pied (Mesure, Filtre, Réglages, Services) ; la dernière est rouverte à la visite suivante
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
    if (id === "reglages") showFolderExport();
  }
  for (const button of paneButtons) button.addEventListener("click", () => showPane(button.dataset.panneau));
  showPane(store.get("panneau", "resultats"));
  $("#vider-cache").addEventListener("click", async () => {
    await pruneGeoCache(0);
    showGeoCache();
  });

  // Fond, instance, centrage ----------------------------------------------------------------

  $("#fond").value = store.get("fond", "plan").replace(/^osm$/, "ofm");  // OpenStreetMap France remplacé par OpenFreeMap
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
  // Bords de route (chute et dévers, ticket #31) : calculés à l'appui sur « Profils », jusqu'à la
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
  // « Profil » : coupe du terrain du dernier calcul de « Profils » pour la photo affichée
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
    const dialog = $("#fenetre-profil");
    const { svg, legend, long } = Profil.draw(edgeProfile.profile, trueScale.checked, nuage.get(nuageKey(edgeProfile.profile)),
      plants.checked, Number($("#camera").value) || 1.9);  // hauteur de caméra des réglages
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
  // Légende pliée à chaque ouverture, le bouton la déplie : l'image PNG et le PDF la gardent ; grisé en loupe, où elle est déjà masquée
  const foldLegend = (on) => {
    const button = $("#profil-legende");
    $("#fenetre-profil").classList.toggle("legende-pliee", on);
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Déplier la légende" : "Replier la légende";
  };
  $("#profil-legende").addEventListener("click", () => foldLegend(!$("#fenetre-profil").classList.contains("legende-pliee")));
  const zoomProfile = (on) => {
    const dialog = $("#fenetre-profil"), button = $("#profil-loupe");
    dialog.classList.toggle("agrandi", on);
    $("#profil-legende").disabled = on;
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
    foldLegend(true);
    drawProfile();
    $("#profil-nuage-etat").textContent = "";
    nuageReady();
    showOverViewer(dialog);
    // Route, PR et commune de la photo, comme l'étiquette du lieu (déjà lus : sans requête)
    Lieu.describe(...feature.geometry.coordinates.slice(0, 2), feature).then(({ parts }) => {
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
      // Bords d'enrobé trouvés : plateforme, chute et dévers du profil relus depuis eux
      const paved = Object.fromEntries(Object.entries(found.bords).filter(([, b]) => b?.comment === "enrobé")
        .map(([side, b]) => [side, Math.abs(b.x)]));
      if (Object.keys(paved).length) {
        app.use_paved_edges(JSON.stringify(profile.repere), JSON.stringify(paved));
        refresh();
      }
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
    await save(await Profil.png(dialog.querySelector("svg"), title, dialog.querySelector(".legende"),
      dialog.querySelector("svg.profil-long")));
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
    const { text, parts } = await Lieu.describe(...feature.geometry.coordinates.slice(0, 2), feature).catch(() => ({ text: "" }));
    const long = $("#profil-pdf-long").checked ? dialog.querySelector("svg.profil-long") : null;
    win.document.open();
    win.document.write(Profil.pdfPage(dialog.querySelector("svg"), dialog.querySelector(".legende"), long, {
      stylesheet: new URL("src/style.css", location.href).href, fonts: FICHE_FONTS, photo: meta?.id || "",
      place: text ? placeMarkup(text, parts) : escapeHtml(edgeProfile?.road || ""),
      edited: `Édité le ${new Date().toLocaleDateString("fr-FR")}`,
    }));
    win.document.close();
    await new Promise((resolve) => (win.document.readyState === "complete" ? resolve() : win.addEventListener("load", resolve)));
    // Styles du site chargés avant d'imprimer : « complete » ne les attend pas sur un document réécrit
    await Promise.all([...win.document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.sheet || new Promise((resolve) => {
      link.addEventListener("load", resolve);
      link.addEventListener("error", resolve);
    })));
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
  // Parcelle visée dans la visionneuse (étiquette et croix), cochée par défaut ; grisée sans le cadastre
  $("#cadastre-visionneuse").checked = store.get("cadastre-visionneuse") !== "0";
  $("#cadastre-visionneuse").disabled = !$("#cadastre").checked;
  $("#cadastre").addEventListener("change", (event) => {
    store.set("cadastre", event.target.checked ? "1" : "0");
    Carte.setCadastre(map, event.target.checked);
    $("#cadastre-visionneuse").disabled = !event.target.checked;
    applyMeasureUi();  // croix du centre de la vue
  });
  $("#cadastre-visionneuse").addEventListener("change", (event) => {
    store.set("cadastre-visionneuse", event.target.checked ? "1" : "0");
    applyMeasureUi();
    showParcelMark();
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
  // Photo ouverte à la première utilisation (et sans dernière photo gardée) : Venarey-les-Laumes (D103T), route plate et droite,
  // vue tournée vers le bâtiment rond sur la gauche (cap en degrés). L'ancienne (Semur-en-Auxois, 7752eb30) était sur un
  // pont pavé : vue Bird Eye sans LiDAR, voie rétrécie
  const DEFAULT_PHOTO = "8625c7ff-90c1-4865-b936-fd8952ac908f";
  const DEFAULT_HEADING = 210;
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
    updatePlayer();  // parcours gardé rouvert : modifié (« ☆ Enregistrer… »)
  });

  // Hauteur de la carte, plein écran de la visionneuse, largeur de la colonne : src/disposition.js
  const { mapBox, grip, fold, setFolded, columnFold, setColumnFolded } = Disposition.init({
    map, store, setStatus, setSwapped,
    wantSwap: () => wantSwap(),  // déclaré plus bas
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
    const { text, complete, parts } = await Lieu.describe(lon, lat, feature);
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
    if (kind === "echec" || kind === "avertissement") noticeInFullscreen(text);
  }
  /** En plein écran, le panneau et sa ligne d'état sont masqués : le message passe sur la visionneuse. */
  function noticeInFullscreen(text) {
    if (document.fullscreenElement) notice(text);
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
    // Longueur sur la carte : la vue du dessus a sa propre inclinaison (verticales ou pente de la route, voir sa barre d'état)
    message.hidden = !measuring || triangulating || $("#mode").value === "carte"
      || !(calibrating || tilt === "attente" || manual || before);
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
  /** Hauteur de chute d'un pont demandée par App.fall : nuage LiDAR lu une fois par demande, réponse rendue au calcul. */
  let bridgeReading = null;
  async function readBridgeFall(ask) {
    if (bridgeReading === ask.key) return;
    bridgeReading = ask.key;
    let answer;
    try {
      answer = await Nuage.bridgeFall(ask.lon, ask.lat, ask.chain) || { none: true };
    } catch (error) {
      console.warn("Hauteur de chute : nuage LiDAR illisible", error);
      answer = { error: true };
    }
    bridgeReading = null;
    refresh(app.use_bridge_lidar(ask.key, JSON.stringify(answer)));
  }

  function refresh(text) {
    if (!app) return;
    setStatus(text ?? app.status());
    updateBirdeye();
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
    // grisés quand ils n'auraient pas d'effet ; départ d'une longueur sur la carte
    $("#effacer").disabled = !state.can_undo && !Dessus.hasStart();
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
    // bords de route après un appui sur « Profils » (pas pendant la lecture)
    const fall = playing() ? null : JSON.parse(app.fall_json());
    const [bridge, ...rest] = (fall?.text || "").split("\n");
    Object.assign($("#chute"), { hidden: !fall, title: fall?.title || "" });
    $("#bords").disabled = playing() || (fall && !fall.edges) || !app.edges_ready();  // pas sur un pont
    edgeProfile = fall?.profile ? fall : null;
    if (fall?.lidar) readBridgeFall(fall.lidar);
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
    if ((!heightAxis && slideKind === "hauteur") || (!aiming && slideKind === "visée")) slideOnGuide(null);
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
          innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
            + 'aria-hidden="true"><path d="M7 3h7l5 5v13H7z M14 3v5h5" stroke-linejoin="round"/></svg>',
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

  // Vue du dessus (src/dessus.js) : photo reprojetée au sol sur la mini-carte
  // photo dont l'inclinaison, les voisines ont été demandées ; fiches de ses voisines (null : en lecture)
  let birdeyeAsked = null, birdeyeNearAsked = null, birdeyeNear = null;
  /** Fiches des photos voisines : { near (précédente, suivante), far (avant la précédente, après la suivante : raccords pour
   * le tangage seulement, voir Dessus.learnPitch) }. */
  async function birdeyeNeighbours(feature) {
    const read = (item, rel) => {
      const link = (item.links || []).find((l) => l.rel === rel);
      return link ? fetch(link.href).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null);
    };
    const [prev, next] = await Promise.all([read(feature, "prev"), read(feature, "next")]);
    const far = await Promise.all([prev && read(prev, "prev"), next && read(next, "next")]);
    return { near: [prev, next].filter(Boolean), far: far.filter(Boolean) };
  }
  let birdeyeFor = null;  // photo pour laquelle Bird Eye a été allumée : une autre photo l'éteint, rien n'est calculé sans clic
  function updateBirdeye() {
    if ($("#dessus").checked && photo && birdeyeFor && birdeyeFor !== photo.id) $("#dessus").checked = false;
    const pose = app && photo ? JSON.parse(app.birdeye_pose()) : null, shown = pose && pose.pic === photo.id;
    $("#dessus").disabled = !shown;
    const on = shown && $("#dessus").checked;
    if (photo) Carte.showView(map, photo.geometry.coordinates, coneHeading(), viewFov());  // cône retiré ou remis
    const inMap = (selector) => mapBox.querySelector(selector);  // réglages sur la carte, peut-être détachée
    for (const id of ["#dessus-fine", "#dessus-voisines", "#dessus-position", "#dessus-bords", "#dessus-sans-cache"])
      inMap(id).disabled = !on;
    if (!on) {  // allumée : selon la vue (Dessus)
      for (const id of ["#dessus-verticales", "#dessus-devers", "#dessus-tangage", "#dessus-tangage-force"]) inMap(id).disabled = true;
    }
    inMap("#dessus-reglages").hidden = !on;  // vue du dessus allumée seulement
    showMapMeasureButton();
    if (on && birdeyeAsked !== photo.id) {
      birdeyeAsked = photo.id;
      birdeyeNear = null;
      app.birdeye_neighbours("[]");
      app.birdeye_far("[]");
      app.birdeye_request();  // peut répondre tout de suite (déjà calée) : la pose est relue ensuite
    }
    // Voisines (« Véhicule masqué ») : fiches lues et inclinaison lancée seulement à la demande
    if (on && inMap("#dessus-voisines").checked && birdeyeNearAsked !== photo.id) {
      birdeyeNearAsked = photo.id;
      const feature = photo;
      birdeyeNeighbours(feature).then(({ near, far }) => {
        if (photo !== feature) return;
        birdeyeNear = [...near, ...far];
        app.birdeye_far(JSON.stringify(far));
        app.birdeye_neighbours(JSON.stringify(near));
        updateBirdeye();
      });
    }
    Dessus.update(on ? photo : null, on ? JSON.parse(app.birdeye_pose()) : null, birdeyeNear);
  }
  // Carte et visionneuse échangées (bouton ⇄ de la carte, ou longueur sur la carte) : la carte prend la place et la taille de
  // la visionneuse, et inversement. Deux gabarits vides gardent la mise en page, #vue et #carte se posent dessus. Carte
  // détachée : déjà à part, rien à échanger.
  const viewerSlot = $("#place-vue"), mapSlot = $("#place-carte");
  function placeSwapped() {
    const set = (name, rect) => {
      for (const side of ["left", "top", "width", "height"]) document.body.style.setProperty(`--${name}-${side}`, `${rect[side]}px`);
    };
    set("place-vue", viewerSlot.getBoundingClientRect());
    set("place-carte", mapSlot.getBoundingClientRect());
    map.resize();
    window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
  }
  const swapWatch = new ResizeObserver(placeSwapped);
  let swapped = false, userSwap = false, measureSwap = false;  // échange en cours ; demandé par le bouton ; par la mesure
  function setSwapped(on) {
    if (on === swapped || (on && mapWindow)) return;
    swapped = on;
    swapButton.setAttribute("aria-pressed", String(on));
    // carte en grand ou détachée : mesure et Bird Eye d'un clic
    measureButton.hidden = birdeyeButton.hidden = captureButton.hidden = exportButton.hidden = !on && !mapWindow;
    swapButton.title = on ? "Remettre la carte et la visionneuse à leur place" : "Échanger la carte et la visionneuse (place et taille)";
    if (on) {
      setColumnFolded(false);
      setFolded(false);
      mapSlot.style.height = `${mapBox.getBoundingClientRect().height}px`;
    }
    viewerSlot.hidden = mapSlot.hidden = !on;
    fold.disabled = columnFold.disabled = on;
    document.body.classList.toggle("carte-en-grand", on);
    if (on) {
      placeSwapped();
      swapWatch.observe(viewerSlot);
      swapWatch.observe(mapSlot);
    } else {
      swapWatch.disconnect();
      map.resize();
      window.dispatchEvent(new Event("resize"));
    }
  }
  const wantSwap = () => setSwapped(!document.fullscreenElement && (userSwap || measureSwap));
  const swapButton = Object.assign(document.createElement("button"), { type: "button", className: "echanger-vues", textContent: "⇄" });
  swapButton.setAttribute("aria-pressed", "false");
  swapButton.title = "Échanger la carte et la visionneuse (place et taille)";
  swapButton.addEventListener("click", () => {
    userSwap = !swapped;
    if (!userSwap) measureSwap = false;  // remis en place à la main, même pendant la mesure
    wantSwap();
  });
  map.addControl({
    onAdd: () => Object.assign(document.createElement("div"),
      { className: "maplibregl-ctrl maplibregl-ctrl-group" }).appendChild(swapButton).parentNode,
    onRemove: () => {},
  }, "top-left");
  // Carte en grand ou détachée : « Mesurer une longueur », sans passer par le mode du bandeau (même mesure que le mode « carte »)
  const measureButton = Object.assign(document.createElement("button"), { type: "button", className: "mesurer-carte", hidden: true,
    textContent: "📏 Mesurer une longueur" });
  measureButton.setAttribute("aria-pressed", "false");
  measureButton.addEventListener("click", () => {
    const on = measuring && $("#mode").value === "carte";
    if (on) return $("#mesure").click();  // arrêt, comme le bouton « Mesure »
    if ($("#mode").value !== "carte") {
      $("#mode").value = "carte";
      $("#mode").dispatchEvent(new Event("change"));
    }
    if (!measuring) $("#mesure").click();
  });
  // Faucon : Bird Eye de la photo affichée, d'un clic (comme l'interrupteur du bandeau) ; une autre photo l'éteint (updateBirdeye)
  const birdeyeButton = Object.assign(document.createElement("button"), { type: "button", className: "birdeye-carte", hidden: true,
    ariaLabel: "Bird Eye" });
  birdeyeButton.append(Object.assign(document.createElement("img"), { src: "src/faucon.svg", alt: "" }));
  birdeyeButton.setAttribute("aria-pressed", "false");
  birdeyeButton.addEventListener("click", () => {
    $("#dessus").checked = !$("#dessus").checked;
    $("#dessus").dispatchEvent(new Event("change"));
  });
  // Capture de la carte (vue Bird Eye et mesures, étiquettes comprises), téléchargée en PNG ; grisé Bird Eye éteinte
  const captureButton = Object.assign(document.createElement("button"), { type: "button", className: "capture-carte", hidden: true,
    innerHTML: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linejoin="round" aria-hidden="true"><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    title: "Capture de la carte : vue Bird Eye et mesures, en image PNG", ariaLabel: "Capture de la carte" });
  captureButton.addEventListener("click", async () => {
    captureButton.disabled = true;
    try {
      const blob = await Carte.capture(map), url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      Object.assign(document.createElement("a"),
        { href: url, download: `bird-eye-${(photo?.id || "carte").slice(0, 8)}-${stamp}.png` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      console.warn("Capture de la carte :", error);
    } finally {
      showMapMeasureButton();
    }
  });
  // Export géoréférencé de la vue Bird Eye pour un SIG (GeoTIFF en Lambert 93) ; grisé Bird Eye éteinte
  const exportButton = Object.assign(document.createElement("button"), { type: "button", className: "capture-carte", hidden: true,
    // carte pliée et repère (géoréférencée)
    innerHTML: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linejoin="round" aria-hidden="true"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
    title: "Vue Bird Eye géoréférencée pour un SIG (QGIS…) : GeoTIFF en Lambert 93, la vue seule, sans fond de carte ni mesures",
    ariaLabel: "Export géoréférencé de la vue Bird Eye" });
  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    try {
      const file = await Dessus.exportView();
      if (!file) {
        notice("Vue Bird Eye pas encore prête : export géoréférencé impossible pour l'instant.");
        return;
      }
      const url = URL.createObjectURL(file.blob);
      Object.assign(document.createElement("a"), { href: url, download: file.name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      console.warn("Export géoréférencé :", error);
      notice(`Export géoréférencé impossible : ${error.message}`);
    } finally {
      showMapMeasureButton();
    }
  });
  map.addControl({
    onAdd: () => {
      const place = Object.assign(document.createElement("div"), { className: "maplibregl-ctrl place-mesurer" });
      place.append(measureButton, birdeyeButton, captureButton, exportButton);
      return place;
    },
    onRemove: () => {},
  }, "top-left");
  /** Bouton de la carte en grand : enfoncé pendant la mesure, grisé sans photo 360° (pas de vue du dessus). */
  function showMapMeasureButton() {
    const on = measuring && $("#mode").value === "carte";
    measureButton.setAttribute("aria-pressed", String(on));
    measureButton.textContent = on ? "📏 Arrêter la mesure" : "📏 Mesurer une longueur";
    measureButton.title = on ? "Arrêter la mesure de longueur sur la carte"
      : "Mesurer une longueur sur la vue Bird Eye : deux clics sur la carte";
    measureButton.disabled = !on && ($("#dessus").disabled || $("#mode").disabled);
    const bird = $("#dessus").checked;
    birdeyeButton.setAttribute("aria-pressed", String(bird));
    birdeyeButton.disabled = $("#dessus").disabled;
    captureButton.disabled = exportButton.disabled = !bird || $("#dessus").disabled;  // rien de Bird Eye à capturer
    birdeyeButton.title = bird ? "Éteindre la vue Bird Eye"
      : "Vue Bird Eye de cette photo (calculée pour elle seule : une autre photo l'éteint)";
  }
  Dessus.setup(map, (on) => {
    measureSwap = on;
    wantSwap();
  });

  /** Mode « Longueur sur la carte » : vue du dessus allumée et clics sur la carte, tant que « Mesure » est enfoncé. */
  function syncMapMeasure() {
    const on = measuring && $("#mode").value === "carte";
    if (on && !$("#dessus").checked && !$("#dessus").disabled) {
      $("#dessus").checked = true;
      $("#dessus").dispatchEvent(new Event("change"));
    }
    Dessus.setMeasuring(on);
  }
  $("#dessus").addEventListener("change", (event) => {
    if (event.target.checked && photo) map.jumpTo({ center: photo.geometry.coordinates });  // le zoom ne bouge pas
    birdeyeFor = event.target.checked && photo ? photo.id : null;
    updateBirdeye();
  });
  mapBox.querySelector("#dessus-voisines").addEventListener("change", updateBirdeye);  // voisines à lire

  // Choix de la photo sur la carte ---------------------------------------------------------

  map.on("click", (event) => {
    // Clic sur le trait de la zone du point d'intérêt (hors tracé) : zone retirée
    if (!parcours.travelPick && poi.zone && map.getLayer(ZONE_ID) && map.queryRenderedFeatures(
      [[event.point.x - 6, event.point.y - 6], [event.point.x + 6, event.point.y + 6]], { layers: [ZONE_ID] }).length) {
      poi.zone = null;
      showPoiZone();
      setStatus("Zone de l'effet retirée : 150 m avant et après le passage au plus près de la cible.");
      updatePlayer();
      return;
    }
    if (measuring && $("#mode").value === "carte") {  // longueur sur la carte : jamais d'autre photo ouverte d'un clic
      if (!Dessus.measuring()) {
        setStatus($("#dessus").disabled ? "Longueur sur la carte : photo 360° nécessaire (Bird Eye indisponible)."
          : "Longueur sur la carte : Bird Eye en préparation, patientez.");
        return;
      }
      const done = Dessus.addPoint(event.lngLat);
      if (done) refresh(app.add_map_length(done.a[0], done.a[1], done.b[0], done.b[1], done.length, done.error, done.photos));
      else refresh();  // Effacer : le départ se retire
      applyMeasureUi();
    } else if (lineDraft !== null) addLinePoint(event.lngLat);
    else if (placing) placeOnMap(event.lngLat);
    else if (addingObject) addObjectAt(event.lngLat);
    else if (parcours.travelPick) pickTravelPoint(event.lngLat);
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
    if (event.key === "Escape" && Dessus.cancelStart()) applyMeasureUi();  // départ d'une longueur sur la carte
    if (event.key === "Escape" && lineDraft !== null) {
      endLineDraft();
      refresh();
    }
    if (event.key === "Escape" && placing) {
      setPlacing(false);
      refresh();
    }
    if (event.key === "Escape" && addingObject) setAddingObject(false);
    if (event.key === "Escape" && parcours.travelPick) {
      poi.draft = null;  // tracé de la zone ou de la planète interrompu
      parcours.planetDraft = null;
      setTravelPick(null);
      showPoiZone();
      showPlanets();
    }
  }
  document.addEventListener("keydown", onLineEscape);

  /** Photo la plus proche du point (lng, lat), qui passe le filtre ; avec un cap `heading`
   * (degrés), celle d'un véhicule roulant dans ce sens à 90° près, à défaut la plus proche. */
  async function openNearest(lng, lat, heading = null, radius = null) {  // radius : voir Carte.photosNear
    showPhotoInfo(null, "Recherche de la photo la plus proche…");
    const sameWay = (feature) => {
      const azimuth = Number(feature.properties?.["view:azimuth"]);
      return Number.isFinite(azimuth) && Math.abs(((azimuth - heading) % 360 + 540) % 360 - 180) < 90;
    };
    try {
      const feature = (heading != null
        ? await Carte.nearestPhoto(map, lng, lat, (f) => passesFilter(f) && sameWay(f), radius) : null)
        || await Carte.nearestPhoto(map, lng, lat, passesFilter, radius);
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
    objectCurrent = id;  // ses attributs et son statut dans le parcours
    showObjectState();
    document.activeElement?.blur?.();  // un bouton cliqué avant (« Exporter »…) ne reçoit pas l'Entrée
    setStatus("Objet de la couche : cliquez sa place dans la photo (le clic le pose et finit), ou flèches pour l'ajuster "
      + "puis Entrée ; Suppr le remet à sa place calculée. La carte n'est pas modifiée.");
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
      ? "Des objets de la couche ont été recalés sur une autre séquence de cette voie, "
        + `à ${Math.round(near[0].d)} m. Aller sur cette photo ?`
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
    endMoving();
  }
  /** Recalage fini (Entrée, Échap, Suppr, ou clic qui pose l'objet) : objet désélectionné. */
  function endMoving() {
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
    if (key === "z" && !event.shiftKey && Dessus.cancelStart()) return applyMeasureUi();  // départ d'une longueur sur la carte
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
    setSwapped(false);  // carte et visionneuse échangées : remises en place d'abord
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
    swapButton.disabled = detached;  // carte déjà à part : rien à échanger
    // détachée : comme en grand
    measureButton.hidden = birdeyeButton.hidden = captureButton.hidden = exportButton.hidden = !detached && !swapped;
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
    $("#plein-ecran").disabled = true;
    if (document.fullscreenElement) document.exitFullscreen();  // plus de photo à montrer
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
    Carte.showView(map, coords, coneHeading(), viewFov());
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
    $("#capture-hd").disabled = !Calcul.hasWorker();  // « Avec annotations » : selon les annotations (updateAnnotationsButton)
    $("#plein-ecran").disabled = !document.fullscreenEnabled;
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
  $("#favoris-exporter").addEventListener("click", async () => download(JSON.stringify(favorites(), null, 1),
    await exportName("favoris", "json"), "application/json"));
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
  /** Test des objets cachés : valeur masquée dans la légende, ou hors du filtre par attribut (overlay.filtre :
   * { colonne, op, valeur }) ; (feature) → vrai si caché. */
  // Nombres comparés en nombres (virgule acceptée), sinon textes sans majuscules ; « ≠ » garde les objets sans valeur
  // (« verif ≠ vérifié » : ceux pas encore vus) ; =, ≠, <, > sans valeur saisie : filtre sans effet
  function overlayHiddenTest() {
    const masked = overlayMasked(), { colonne, op, valeur = "" } = overlay?.filtre || {};
    const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(",", ".")) : NaN);
    const want = valeur.trim(), wantN = num(want), test = op === "vide" || op === "rempli" || want;
    const keep = (v) => {
      const empty = v == null || String(v).trim() === "";
      if (op === "vide" || op === "rempli") return empty === (op === "vide");
      if (empty) return op === "≠";
      const n = num(v);
      const cmp = Number.isFinite(n) && Number.isFinite(wantN) ? n - wantN
        : String(v).trim().localeCompare(want, "fr", { sensitivity: "base", numeric: true });
      return op === "=" ? cmp === 0 : op === "≠" ? cmp !== 0 : op === "<" ? cmp < 0 : cmp > 0;
    };
    return (f) => masked.has(f?.properties._cle) || Boolean(colonne && test && !keep(f?.properties[colonne]));
  }

  /** Réglages du filtre affichés (overlay.filtre) ; conditions grisées sans colonne, valeur sans objet pour vide / non vide. */
  function showOverlayFilter() {
    const { colonne = "", op = "=", valeur = "" } = overlay?.filtre || {};
    $("#couche-filtre").value = colonne;
    $("#couche-filtre-op").value = op;
    $("#couche-filtre-valeur").value = valeur;
    $("#couche-filtre-op").disabled = $("#couche-filtre-effacer").disabled = !colonne;
    $("#couche-filtre-valeur").disabled = !colonne || op === "vide" || op === "rempli";
  }
  function setOverlayFilter(filter) {
    overlay.filtre = filter.colonne ? filter : null;
    showOverlayFilter();
    showOverlayStyle();
    saveOverlay();
  }
  const readFilter = () => ({ colonne: $("#couche-filtre").value, op: $("#couche-filtre-op").value,
    valeur: $("#couche-filtre-valeur").value });
  for (const id of ["#couche-filtre", "#couche-filtre-op"]) $(id).addEventListener("change", () => setOverlayFilter(readFilter()));
  $("#couche-filtre-valeur").addEventListener("input", () => setOverlayFilter(readFilter()));  // à chaque lettre
  $("#couche-filtre-effacer").addEventListener("click", () => setOverlayFilter({}));

  const EYE_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + 'aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_SHUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + 'aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.2 3.9'
    + 'M6.6 6.6C3.8 8.4 2 12 2 12s3.5 6 10 6a9.6 9.6 0 004.4-1" stroke-linecap="round"/></svg>';

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
    const hidden = overlayHiddenTest(), shown = overlay.features.filter((f) => !hidden(f));
    Carte.showOverlay(map, $("#couche-visible").checked ? { type: "FeatureCollection", features: shown } : null);
    $("#couche-filtre-bilan").hidden = !overlay.filtre;
    $("#couche-filtre-bilan").textContent = `${shown.length} objet${shown.length > 1 ? "s" : ""} sur ${overlay.features.length}`;
    refresh();
    showObjectTable();
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

  // Parcours des objets de la couche : tableau trié (clic sur un intitulé) et filtré par la recherche ; ◀ ▶ dans son
  // ordre. Statut de vérification dans les colonnes « verif » et « verif_note » (10 lettres au plus : Shapefile), ajoutées
  // à la couche au premier statut, gardées et exportées comme ses autres colonnes.
  let objectSort = { key: "", up: true };  // "" : ordre du fichier
  let objectCurrent = null;  // n° de l'objet du parcours
  let objectOrder = [];  // n° des objets du tableau, dans son ordre

  function showObjectTable() {
    if (!overlay || !$("#couche-parcours").open) return showObjectState();
    const label = $("#couche-etiquette").value;
    const columns = [["", "Objet"], ...(label ? [[label, label]] : []), ["verif", "Statut"]];
    const value = (i, key) => (key ? Couche.format(overlay.features[i].properties[key]) : overlayObjectName(i));
    const query = $("#objets-recherche").value.trim().toLowerCase();
    const hidden = overlayHiddenTest();
    objectOrder = overlay.features.map((_, i) => i).filter((i) => !hidden(overlay.features[i]))
      .filter((i) => !query || [overlayObjectName(i),
      ...Object.values(overlayProperties(overlay.features[i])).map(Couche.format)].some((v) => v.toLowerCase().includes(query)));
    const { key, up } = objectSort;
    if (key || !up) {
      objectOrder.sort((a, b) => (up ? 1 : -1) * (value(a, key).localeCompare(value(b, key), "fr", { numeric: true }) || a - b));
    }
    $("#objets-entete").replaceChildren(...columns.map(([k, title]) => {
      const th = Object.assign(document.createElement("th"), { scope: "col", textContent: title, title: "Trier" });
      if (k === key) th.setAttribute("aria-sort", up ? "ascending" : "descending");
      th.addEventListener("click", () => {
        objectSort = { key: k, up: k !== key || !up };
        showObjectTable();
      });
      return th;
    }));
    $("#objets-lignes").replaceChildren(...objectOrder.map((i) => {
      const tr = document.createElement("tr");
      tr.append(...columns.map(([k]) => Object.assign(document.createElement("td"), { textContent: value(i, k) })));
      tr.setAttribute("aria-selected", String(i === objectCurrent));
      tr.addEventListener("click", () => goToObject(i));
      return tr;
    }));
    showObjectState();
  }

  /** Objet du parcours, ◀ ▶, statut et commentaire : grisés tant qu'ils ne peuvent servir. */
  function showObjectState() {
    const k = objectOrder.indexOf(objectCurrent), on = overlay && objectCurrent != null;
    $("#objet-precedent").disabled = !overlay || k <= 0;
    $("#objet-suivant").disabled = !overlay || !objectOrder.length || k === objectOrder.length - 1;
    $("#objet-statut").disabled = $("#objet-note").disabled = $("#objet-supprimer").disabled = !on;
    $("#objet-ajouter").disabled = !overlay;
    showObjectAttributes();
    const p = on ? overlay.features[objectCurrent].properties : {};
    $("#objet-courant").textContent = on ? `Objet ${overlayObjectName(objectCurrent)}${k >= 0 ? ` (${k + 1}/${objectOrder.length})` : ""}`
      : "Cliquez un objet du tableau, ou ▶";
    $("#objet-statut").value = p.verif || "";
    if (document.activeElement !== $("#objet-note")) $("#objet-note").value = p.verif_note || "";
    for (const tr of $("#objets-lignes").children)
      tr.setAttribute("aria-selected", String(objectOrder[tr.sectionRowIndex] === objectCurrent));
  }

  /** Attributs de l'objet du parcours, modifiables (sans les colonnes techniques d'un relevé, ni statut et
   * commentaire) ; refaits seulement quand l'objet ou les colonnes changent (un champ en cours garde la main).
   * Colonne oui / non : case à cocher ; texte : valeurs des autres objets proposées (liste du navigateur, valeur
   * nouvelle possible) ; nombres : rien de proposé. */
  let attributesKey = "";
  function showObjectAttributes() {
    const on = overlay && objectCurrent != null;
    const columns = on
      ? overlay.columns.filter((c) => !(overlay.techniques || []).includes(c) && !["verif", "verif_note"].includes(c)) : [];
    const key = on ? `${objectCurrent}|${columns.join("|")}` : "";
    if (key === attributesKey) return;
    attributesKey = key;
    const p = on ? overlay.features[objectCurrent].properties : {};
    $("#objet-attributs").replaceChildren(...columns.map((c, k) => {
      const label = Object.assign(document.createElement("label"), { textContent: c });
      const values = overlay.features.map((f) => f.properties[c]).filter((v) => v != null && v !== "");
      const yesNo = values.length && values.every((v) => typeof v === "boolean" || /^(oui|non)$/i.test(v));
      if (yesNo) {  // oui / non : case à cocher, valeur écrite dans la forme de la colonne (booléen, ou « oui » / « non »)
        const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: p[c] === true || /^oui$/i.test(p[c]) });
        const asText = values.some((v) => typeof v === "string");
        box.addEventListener("change", () => setObjectValue(c, asText ? (box.checked ? "oui" : "non") : box.checked));
        label.append(box);
        return label;
      }
      const input = Object.assign(document.createElement("input"), { type: "text", value: p[c] == null ? "" : String(p[c]) });
      input.addEventListener("change", () => setObjectAttribute(c, input.value));
      label.append(input);
      if (values.some((v) => typeof v !== "number")) {  // texte : valeurs des autres objets proposées, à jour à chaque saisie
        const list = Object.assign(document.createElement("datalist"), { id: `objet-valeurs-${k}` });
        input.setAttribute("list", list.id);
        input.addEventListener("focus", () => list.replaceChildren(...[...new Set(overlay.features.map((f) => f.properties[c])
          .filter((v) => v != null && v !== "").map(String))].sort((x, y) => x.localeCompare(y, "fr", { numeric: true }))
          .map((v) => new Option(v))));
        label.append(list);
      }
      return label;
    }));
  }

  /** Attribut de l'objet du parcours : vide → null ; nombre si la colonne en a ailleurs (virgule acceptée). */
  function setObjectAttribute(column, text) {
    const t = text.trim(), n = Number(t.replace(",", "."));
    const numeric = overlay.features.some((f) => typeof f.properties[column] === "number");
    setObjectValue(column, !t ? null : numeric && Number.isFinite(n) ? n : t);
  }
  function setObjectValue(column, value) {
    overlay.features[objectCurrent].properties[column] = value;
    objectEdited();
  }

  /** Couche modifiée (attribut, statut ; geometry : objet ajouté ou supprimé, numéros refaits) : à réenregistrer. */
  function objectEdited(geometry = false) {
    if (geometry) {
      overlay.features.forEach((f, i) => { f.id = i; });
      overlayAt.clear();
      attributesKey = "";
      app.set_overlay(JSON.stringify(overlay.features.map(({ id, geometry }) => ({ id, geometry }))));
      showOverlayInfo();
    }
    setOverlayChanged(true);  // à réenregistrer dans le fichier
    saveOverlay();
    showOverlayStyle();  // carte, photo, légende, tableau
  }

  $("#objet-supprimer").addEventListener("click", async () => {
    const i = objectCurrent;
    if (await ask($("#supprimer-objet"), `L'objet ${overlayObjectName(i)} sera retiré de la couche. Le fichier ne change `
      + "qu'à l'enregistrement.") !== "supprimer" || objectCurrent !== i) return;
    overlay.features.splice(i, 1);
    moving = null;
    objectCurrent = null;
    objectEdited(true);
  });

  // Objet ajouté : un point posé d'un clic sur la mini-carte, attributs vides à saisir ; Échap annule
  let addingObject = false;
  function setAddingObject(on) {
    addingObject = on;
    map.getCanvas().style.cursor = on ? "crosshair" : "";
    $("#objet-ajouter").textContent = on ? "Annuler (Échap)" : "＋ Ajouter un objet";
    $("#objet-ajouter").setAttribute("aria-pressed", String(on));
    if (on) setStatus("Couche : cliquez sur la mini-carte la place du nouvel objet (zoomez pour être précis) ; Échap pour annuler.");
  }
  function addObjectAt({ lng, lat }) {
    setAddingObject(false);
    const properties = Object.fromEntries(overlay.columns.map((c) => [c, null]));
    // Colonne « id » (sans tenir compte de la casse) : le plus grand numéro existant + 1, dans la forme de la colonne
    // (nombre, ou texte de même largeur : « 007 » → « 008 ») ; aucun id numérique : laissée vide
    const idColumn = overlay.columns.find((c) => c.toLowerCase() === "id");
    const ids = idColumn ? overlay.features.map((f) => f.properties[idColumn]).filter((v) => /^\d+$/.test(String(v ?? "").trim())) : [];
    if (ids.length) {
      const top = ids.reduce((a, b) => (Number(b) > Number(a) ? b : a));
      const next = Number(top) + 1;
      properties[idColumn] = typeof top === "number" ? next : String(next).padStart(String(top).trim().length, "0");
    }
    overlay.features.push({ type: "Feature", id: overlay.features.length,
      geometry: { type: "Point", coordinates: [lng, lat] }, properties });
    objectEdited(true);
    setStatus("Objet ajouté à la couche : saisissez ses attributs sous le statut.");
    goToObject(overlay.features.length - 1);
  }
  $("#objet-ajouter").addEventListener("click", () => setAddingObject(!addingObject));

  /** Objet n° i de la couche : photo la plus proche (ou celle de son recalage) ouverte, tournée vers lui. */
  async function goToObject(i) {
    objectCurrent = i;
    showObjectState();
    try {
      const data = await overlayFicheData(i, [], true);
      if (!data.photo) return setStatus("Aucune photo trouvée près de cet objet (filtre, instance ?).", "echec");
      if (photo?.id !== data.photo) await openPhotoReady(data.photo);
      if (objectCurrent !== i) return;  // un autre objet choisi entre-temps
      // Dessiné dans la photo une fois le sol lu (5 s au plus, puis à plat) ; masqué ou trop loin : tourné vers sa position
      await (async () => { for (let t = 0; t < 24 && !overlayEnds(i).length; t++) await new Promise((r) => setTimeout(r, 250)); })();
      const ends = overlayEnds(i), azimuth = Number(photo.properties?.["view:azimuth"]);
      if (ends.length) frameView(ends);
      else if (Number.isFinite(azimuth)) {
        const [lon0, lat0] = photo.geometry.coordinates;
        const bearing = Math.atan2((data.lon - lon0) * Math.cos(lat0 * Math.PI / 180), data.lat - lat0);
        psv.animate({ yaw: bearing - azimuth * Math.PI / 180, pitch: 0, speed: 1200 });
      }
    } catch (error) {
      notice(`Objet ${overlayObjectName(i)} : ${error.message}`);
    }
  }

  /** Statut ou commentaire de l'objet du parcours ; la colonne est ajoutée à la couche à sa première valeur. */
  function setObjectCheck(column, text) {
    overlay.features[objectCurrent].properties[column] = text;
    if (text && !overlay.columns.includes(column)) {
      overlay.columns.push(column);
      for (const id of ["#couche-couleur", "#couche-etiquette", "#couche-etiquette2", "#couche-etiquette-carte", "#couche-filtre"]) {
        $(id).append(new Option(column, column));
      }
    }
    objectEdited();  // couleur ou étiquette selon le statut, tableau
  }
  $("#couche-parcours").addEventListener("toggle", showObjectTable);
  $("#objets-recherche").addEventListener("input", showObjectTable);
  $("#objet-statut").addEventListener("change", (event) => setObjectCheck("verif", event.target.value));
  $("#objet-note").addEventListener("change", (event) => setObjectCheck("verif_note", event.target.value.trim()));
  for (const [id, step] of [["#objet-precedent", -1], ["#objet-suivant", 1]]) $(id).addEventListener("click", () => {
    const k = objectOrder.indexOf(objectCurrent);
    goToObject(objectOrder[k < 0 ? 0 : k + step]);
  });

  /** Couche en place (lue d'un fichier, ou gardée) : calcul, réglages, carte ; cadrée dessus si fit. */
  // mapLabel : colonne de l'étiquette de la mini-carte ; null : « id » (sans tenir compte de la casse), sinon la première
  function loadOverlay(name, read, color = "", label = "", fit = false, visible = true, colors = {}, masks = {},
    mapLabel = null, label2 = "") {
    overlay = { name, ...read, couleurs: colors, masques: masks };  // masques : { colonne: [clés de légende masquées] }
    if (!overlay.filtre?.colonne || !read.columns.includes(overlay.filtre.colonne)) overlay.filtre = null;  // gardé (restoreOverlay)
    moving = null;  // couleurs choisies : { colonne: { clé de légende: couleur } }
    objectCurrent = null;
    $("#couche-visible").checked = visible;
    const n = app.set_overlay(JSON.stringify(read.features.map(({ id, geometry }) => ({ id, geometry }))));
    // Relevé (envoyé, ou réimporté) : colonnes techniques hors des listes, gardées dans les exports
    const technical = RELEVE_TECHNIQUES.every((c) => read.columns.includes(c)) ? RELEVE_TECHNIQUES : [];
    const choices = read.columns.filter((c) => !technical.includes(c));
    overlay.techniques = technical;
    mapLabel ??= choices.find((c) => c.toLowerCase() === "id") ?? choices[0] ?? "";
    for (const [id, value] of [["#couche-couleur", color], ["#couche-etiquette", label], ["#couche-etiquette2", label2],
      ["#couche-etiquette-carte", mapLabel], ["#couche-filtre", ""]]) {
      $(id).replaceChildren(new Option(id === "#couche-couleur" ? "couleur unique" : id === "#couche-filtre" ? "aucun" : "aucune", ""),
        ...choices.map((c) => new Option(c, c)));
      $(id).value = choices.includes(value) ? value : "";
    }
    $("#couche-nom").textContent = name;
    showOverlayInfo();
    showOverlayFilter();
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
  // Couche gardée dans IndexedDB (clé « couche-texte » : centaines de Mo, localStorage plafonne vers 5 Mo) ; sans IndexedDB
  // (navigation privée de certains navigateurs), dans localStorage. Écritures enchaînées : la dernière gagne.
  // Promesse : vrai si la couche est gardée.
  let overlaySaving = Promise.resolve(true);
  const overlayWrite = (write, fallback) => {
    overlaySaving = overlaySaving.then(() => fileStore("readwrite", write)).then(() => {
      store.set("couche", "");  // ancienne place (versions d'avant IndexedDB) vidée
      return true;
    }, fallback);
    return overlaySaving;
  };
  function saveOverlay() {
    if (!overlay) return Promise.resolve(true);
    const text = JSON.stringify(overlaySaved());
    return overlayWrite((s) => s.put(text, "couche-texte"), () => store.set("couche", text));
  }
  /** Couche et ses réglages tels que gardés dans le navigateur (restoreOverlay, dossier de travail). */
  function overlaySaved() {
    const { name, features, columns, crs, couleurs, masques, fiche, filtre } = overlay;
    return { name, columns, crs, couleurs, masques, fiche, filtre, couleur: $("#couche-couleur").value,
      etiquette: $("#couche-etiquette").value,
      intitule: $("#couche-intitule").checked, suffixe: $("#couche-suffixe").value, etiquetteCarte: $("#couche-etiquette-carte").value,
      etiquette2: $("#couche-etiquette2").value, intitule2: $("#couche-intitule2").checked, suffixe2: $("#couche-suffixe2").value,
      modifie: Boolean(overlay.modifie), dateFichier: overlay.dateFichier ?? null,
      visible: $("#couche-visible").checked,
      features: features.map(({ type, id, geometry, properties, recalages }) => ({ type, id, geometry, recalages,
        properties: Object.fromEntries(Object.entries(properties).filter(([k]) => !k.startsWith("_"))) })) };
  }

  /** Couche gardée (overlaySaved) remise en place avec ses réglages ; fit : carte cadrée dessus. Faux sans objet. */
  function applySavedOverlay(saved, fit = false) {
    $("#couche-intitule").checked = Boolean(saved?.intitule);
    $("#couche-suffixe").value = saved?.suffixe || "";
    $("#couche-intitule2").checked = Boolean(saved?.intitule2);
    $("#couche-suffixe2").value = saved?.suffixe2 || "";
    if (!saved?.features?.length) return false;
    loadOverlay(saved.name, saved, saved.couleur, saved.etiquette, fit, saved.visible !== false,
      saved.couleurs || {}, saved.masques || {}, saved.etiquetteCarte ?? null, saved.etiquette2 || "");
    setOverlayChanged(Boolean(saved.modifie));
    return true;
  }

  /** Couche gardée de la session précédente, remise une fois le calcul prêt (voir le démarrage). */
  async function restoreOverlay() {
    const kept = await fileStore("readonly", (s) => s.get("couche-texte")).catch(() => null);
    if (overlay) return;  // couche importée pendant la lecture : elle l'emporte
    let saved = null;  // sinon, ancienne place (localStorage), reprise une fois dans IndexedDB
    try { saved = JSON.parse(kept ?? (store.get("couche") || "null")); } catch { /* illisible : aucune */ }
    if (!applySavedOverlay(saved)) return;
    if (kept == null) saveOverlay();
    const restored = overlay;  // fichier de la couche (Chrome, Edge), relu de façon asynchrone
    fileStore("readonly", (s) => s.get("couche")).then((handle) => {
      if (overlay === restored && handle?.name === restored.name) restored.fichier = handle;
    }).catch(() => null);
  }

  // Chrome, Edge : fichier choisi avec sa poignée, pour y réenregistrer (« Enregistrer ») ; sinon, champ de fichier
  for (const id of ["#couche-importer", "#couche-remplacer"]) $(id).addEventListener("click", async () => {
    if (!window.showOpenFilePicker) return $("#couche-fichier").click();
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true, types: [{ description: "Couches (GeoJSON, Shapefile, GeoPackage, CSV)",
        accept: { "application/octet-stream": [".geojson", ".json", ".zip", ".shp", ".dbf", ".prj", ".cpg", ".shx",
          ".gpkg", ".csv", ".txt"] } }] });
    } catch (error) {
      if (error.name !== "AbortError") $("#couche-fichier").click();  // sélecteur refusé : champ de fichier
      return;
    }
    importFiles(await Promise.all(handles.map((h) => h.getFile())), handles, importOverlay);
  });
  $("#mesures-importer").addEventListener("click", () => $("#couche-importer").click());  // même sélecteur de fichier
  $("#couche-fichier").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    importFiles(files, [], importOverlay);
  });
  // Fichier glissé sur l'onglet Couche (avec son .dbf et son .prj pour un Shapefile) : survol marqué ; le dépôt, lui,
  // est reçu par la page entière (importFiles)
  const layerTab = $("#couche");
  layerTab.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    layerTab.classList.add("survol");
  });
  layerTab.addEventListener("dragleave", (event) => {
    if (!layerTab.contains(event.relatedTarget)) layerTab.classList.remove("survol");
  });

  // Import commun : fichier choisi par n'importe quel bouton d'import, ou glissé n'importe où sur la page (sans quoi
  // le navigateur l'ouvrirait à la place de la page), reconnu par son contenu et rangé à sa place : couche (GeoJSON,
  // mesures exportées comprises ; Shapefile, GeoPackage, CSV), parcours, modèles de champs, calage, favoris.
  // own(fichier, texte, données) : import du bouton utilisé, pour un fichier JSON non reconnu (son message d'erreur).
  async function importFiles(files, handles = [], own = null) {
    const json = files.filter((f) => /\.(geo)?json$/i.test(f.name)), layer = files.filter((f) => !json.includes(f));
    if (layer.length) await importOverlay(layer, handles);
    for (const file of json) {
      const text = await file.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* illisible : non reconnu */ }
      const kind = jsonKind(data);
      if (kind === "couche") await importOverlay([file], handles.filter((h) => h.name === file.name));
      else if (kind === "parcours") importRoutes(data);
      else if (kind === "modeles") importModels(data, file.name);
      else if (kind === "calage") importCalibration(text);
      else if (kind === "favoris") importFavorites(data);
      else if (kind === "dossier") await importFolder(data, file.name);
      else if (own && own !== importOverlay) own(data, file.name, text);
      else if (own) await importOverlay([file]);  // couche : l'erreur de lecture du GeoJSON
      else notice(`« ${file.name} » : fichier non reconnu (ni couche ni mesures, ni favoris, parcours, calage ou modèles de champs).`);
    }
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** Sorte d'un fichier JSON lu, d'après son contenu : « couche », « dossier », « parcours », « modeles », « calage », « favoris »
   * ou "". */
  function jsonKind(d) {
    if (d?.type === "FeatureCollection" || d?.type === "Feature") return "couche";
    if (d?.format === DOSSIER_FORMAT) return "dossier";
    if (d?.format === "parcours-panoramax" || (d && !Array.isArray(d) && d.travel)
      || (Array.isArray(d) && d.length && d.every((r) => r?.travel))) return "parcours";
    if (d?.format === MODELES_FORMAT) return "modeles";
    if (d?.format === 1 && d.verticals) return "calage";  // App.calibration_json (Calibration.FORMAT)
    if (Array.isArray(d) && d.length && d.every((f) => UUID.test(f?.id))) return "favoris";
    return "";
  }
  /** Champ de fichier d'un bouton d'import : fichiers choisis vers l'import commun, own pour un JSON non reconnu. */
  function fileInput(id, own) {
    $(id).addEventListener("change", (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      if (files.length) importFiles(files, [], own);
    });
  }
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", async (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    layerTab.classList.remove("survol");
    const files = [...event.dataTransfer.files];
    // Poignées demandées pendant l'événement (Chrome, Edge), lues ensuite
    const asked = [...event.dataTransfer.items].map((item) => item.getAsFileSystemHandle?.());
    importFiles(files, (await Promise.all(asked.map((p) => p?.catch(() => null)))).filter(Boolean));
  });

  /** Couche lue des fichiers choisis ou glissés, remplaçant celle en place ; handles : leurs poignées (Chrome,
   * Edge), celle d'un GeoJSON seul gardée pour y réenregistrer. */
  async function importOverlay(files, handles = []) {
    if (!files.length || !app) return;
    try {
      setStatus("Lecture de la couche…");
      // GeoPackage de plusieurs tables : celle à afficher, par son numéro
      const choose = (names) => (names.length < 2 ? names[0]
        : names[Number(prompt(`Tables du GeoPackage :\n${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n`
          + "Numéro de la table à afficher :", "1")) - 1]);
      const { name, ...read } = await Couche.readFiles(files, choose);
      // Mesures exportées (App._records) : leur valeur en étiquette, la première revue sur sa photo
      const review = read.columns.includes("vue_ref") ? read.features.findIndex((f) => f.properties.photo_ref) : -1;
      const label = review >= 0 && read.columns.includes("etiquette") ? "etiquette" : "";
      const n = loadOverlay(name, read, "", label, true, true, {}, {}, label || null);
      setOverlayFile(handles.length === 1 && /\.(geo)?json$/i.test(handles[0].name) ? handles[0] : null, files[0].lastModified);
      setOverlayChanged(false);
      const kept = await saveOverlay();
      setStatus(`Couche « ${name} » importée : ${n} partie${n > 1 ? "s" : ""} d'objets.`
        + (kept ? "" : " Trop grosse pour être gardée dans le navigateur : à réimporter à la prochaine ouverture.")
        + (review >= 0 ? " Cliquez une mesure sur la carte pour la revoir sur sa photo." : ""));
      if (review >= 0) reviewMeasure(review);
    } catch (error) {
      setStatus(`Couche non importée : ${error.message}`, "echec");
    }
  }
  // à chaque lettre : étiquettes à jour en tapant
  for (const id of ["#couche-suffixe", "#couche-suffixe2"]) $(id).addEventListener("input", () => {
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
  const overlayBaseName = () => overlay.name.replace(/\.(geojson|json|zip|shp|gpkg|csv|txt)\b.*$/i, "").replace(/[\\/:*?"<>|]/g, "-");
  /** La couche en GeoJSON (WGS 84), recalages dans les photos compris. */
  const overlayGeojson = () => JSON.stringify({ type: "FeatureCollection",
    features: overlay.features.map((f) => ({ type: "Feature", geometry: f.geometry, recalages: f.recalages,
      properties: overlayProperties(f) })) });
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
        if (allowed && !file)
          setStatus(`Fichier « ${handle.name} » introuvable (effacé ou déplacé) : choisissez où enregistrer la couche.`);
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
    objectCurrent = null;
    objectOrder = [];
    setAddingObject(false);
    showObjectState();
    overlayWrite((s) => s.delete("couche-texte"), () => store.set("couche", ""));
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
  fileInput("#favoris-fichier", importFavorites);
  /** Favoris lus d'un fichier (JSON [{ id, name }]), ajoutés à ceux gardés. */
  function importFavorites(read) {
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
  }

  async function addFavorite() {
    const feature = photo;
    if (!feature || favorites().some((f) => f.id === feature.id)) return;
    const [lon, lat] = feature.geometry.coordinates;
    const { parts } = await Lieu.describe(lon, lat, feature);
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

  /** Cap du cône de la vue sur la carte ; null (croix seule) avec Bird Eye, qui couvrirait la vue du dessus. */
  function coneHeading() { return $("#dessus").checked ? null : viewHeading(); }

  let guideHeading = null;
  function updateCursor() {
    if (photo) Carte.showView(map, photo.geometry.coordinates, coneHeading(), viewFov());
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
  const CROSS_PX = 8;  // 99 % des clics à la souris tombent à moins de 4,5 px (mesure à la souris, ticket #43)
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

  /** Largeur, visée suivante : point du trait d'une visée déjà faite (vert, ligne épipolaire) le plus proche de (x, y)
   * dans la visionneuse, à SIGHT_PX pixels au plus, ou null. Un bord n'a pas de repère le long de son tracé : sur ce
   * trait, la visée retombe au même endroit du bord que les précédentes. */
  const SIGHT_PX = 12;
  function onSighting(x, y) {
    if (!measuring || $("#mode").value !== "road" || !aiming) return null;
    const view = psv?.getPosition?.();
    if (!view) return null;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    let best = null, bestD = SIGHT_PX;
    for (const mark of currentMarks.filter((m) => m.epipolar)) {
      for (let i = 1; i < mark.points.length; i++) {
        const [y0, p0] = mark.points[i - 1], [y1, p1] = mark.points[i];
        const visible = [[y0, p0], [y1, p1]].every(([yaw, pitch]) =>
          Math.sin(pitch) * Math.sin(view.pitch) + Math.cos(pitch) * Math.cos(view.pitch) * Math.cos(yaw - view.yaw) > 0.05);
        if (!visible) continue;
        const a = psv.dataHelper.sphericalCoordsToViewerCoords({ yaw: y0, pitch: p0 });
        const b = psv.dataHelper.sphericalCoordsToViewerCoords({ yaw: y1, pitch: p1 });
        const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
        const t = length2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0;
        const d = Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
        if (d <= bestD) {
          bestD = d;
          best = { yaw: y0 + t * wrap(y1 - y0), pitch: p0 + t * (p1 - p0) };
        }
      }
    }
    return best;
  }
  let freeAim = false;  // touche Maj tenue au dernier mouvement du pointeur : visée libre, hors du trait

  function slideOnGuide(event) {
    if (!psv) return;
    freeAim = !!event?.shiftKey;
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
    if (event && onPhoto && !freeAim) {
      const position = onSighting(event.clientX - box.left, event.clientY - box.top);
      if (position) return showSlide(position, "visée");
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
      Traits.setSlide(position && { at: [position.yaw, position.pitch], color: reticleColor(tilted, false, kind === "visée"),
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
            else if (movingId() === Number(id)) endMoving();  // déjà choisi : second clic, désélectionné
            else moveOverlayObject(Number(id));
            return true;
          }
          if (movingId() !== null && !event.data?.rightclick) {  // posé : recalage fini, le clic suivant ne le bouge plus
            placeOverlayObject(event.data.yaw, event.data.pitch);
            endMoving();
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
            const held = inside && !freeAim ? onSighting(x, y) : null;  // comme le réticule (slideOnGuide)
            refresh(photoReady() ? app.click(held?.yaw ?? event.data.yaw, held?.pitch ?? event.data.pitch, onCross) : LOADING);
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
        if (event.target.closest?.(".psv-canvas-container, .psv-markers") && active?.matches?.("input, select, textarea, button"))
          active.blur();
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
      psv.addEventListener("picture-loading", waitParcelTiles);  // étiquette de parcelle : après la HD
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

  // Lecture de la séquence et onglet « Vidéo » (parcours, effets, parcours gardés, vidéo) : src/parcours.js
  const parcours = Parcours.init({
    get psv() { return psv; }, get photo() { return photo; }, get app() { return app; },
    get measuring() { return measuring; },
    map, viewer, store, instance, follow, metresBetween, setStatus, refresh, showPane, fileInput, ask, passesFilter,
    filterActive, notice, applyFilter, addProducer, saveAs, exportName, download,
  });
  const {
    updatePlayer, stopPlayer, playing, attachPlayer, loadRanks, savedRoutes, importRoutes, poi, ZONE_ID, showPoiZone,
    showPlanets, setTravelPick, pickTravelPoint, refreshPoiTargets,
  } = parcours;

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
    showMapMeasureButton();
    const mode = $("#mode").value;
    // Longueur sur la carte : tout se fait sur la carte, pas d'aide dans la visionneuse
    $("#mode-mesure").hidden = !measuring || mode === "carte";
    $("#entete-etape").hidden = mode === "carte";
    // Liseré autour de la visionneuse : bleu pendant les visées de triangulation, jaune pendant la
    // prise de mesure (couleurs de leurs croix)
    const sighting = measuring && aiming && mode !== "carte";  // longueur sur la carte : le cœur reste en mesure libre, sans visée
    const taking = measuring && !aiming && ["road", "height", "carte"].includes(mode);
    const calibrating = measuring && mode === "tilt";
    $("#vue").classList.toggle("visee", sighting);
    $("#vue").classList.toggle("prise", taking);
    $("#vue").classList.toggle("calage", calibrating);
    // Largeur, hauteur, mesure libre : trait vertical au centre de la vue, le cap tracé sur la
    // carte ; la vue tournée vers le point à viser (take_aim_frame), il le désigne (ticket #26)
    $("#axe-vue").hidden = !measuring || !["road", "height", "tri", "releve"].includes(mode) || viewer.hidden;
    $("#croix-cadastre").hidden = !$("#cadastre").checked || !$("#cadastre-visionneuse").checked || viewer.hidden;
    // Même état en toutes lettres, sous le rappel du mode (comme les voyants)
    // Carte d'étape (en bas, en mesure) : nom de la mesure et ses étapes, la courante en couleur
    $("#vue").classList.toggle("en-mesure", measuring);
    const [title, steps, current] = mode === "height" ? ["Hauteur", ["Pied", "Sommet"], aiming ? 0 : newMeasure ? 2 : 1]
      : mode === "road" ? ["Largeur", ["Premier bord", "Bord opposé"], aiming && !edgeBAiming ? 0 : newMeasure ? 2 : 1]
      : mode === "tri" ? ["Mesure libre", ["Points visés depuis plusieurs photos"], 0]
      : mode === "releve" ? ["Relevé d'objets", ["Objet visé", "Ses champs"], 0]
      : mode === "carte" ? ["Longueur sur la carte", ["Départ", "Arrivée"], Dessus.hasStart() ? 1 : 0]
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
      : mode === "releve"
        ? "Relevé d'objets : visez l'objet depuis plusieurs photos puis « Valider le point triangulé », ou gardez-le sur une seule photo"
      : mode === "height" && aiming
        ? "Hauteur, étape 1 : visez le pied depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "height" && newMeasure
        ? `Hauteur faite : cliquez une de ses croix pour l'ajuster ; autre hauteur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "height" ? "Hauteur, étape 2 : cliquez le sommet (le pied est le point visé) ; autre photo : par la carte"
      : mode === "road" && edgeBAiming ? "Largeur, bord opposé : le clic de la mesure est la 1re visée ; photo suivante, même bord "
        + "(réticule calé sur le trait vert, Maj : visée libre), puis « Valider le point triangulé »"
      : mode === "road" && aiming ? "Largeur, étape 1 : visez le premier bord depuis plusieurs photos (flèches), de préférence un "
        + "repère net (fin de tiret, joint, regard) ; réticule calé sur le trait vert, Maj : visée libre ; "
        + "puis « Valider le point triangulé »"
      : mode === "road" && newMeasure
        ? `Largeur faite : cliquez une de ses croix pour l'ajuster ; autre largeur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "road" ? "Largeur, étape 2 : cliquez le bord opposé ; autre photo, prise avant ou après : par la carte"
      : mode === "carte" ? `Longueur sur la carte : cliquez ${Dessus.hasStart() ? "l'arrivée" : "le départ"} sur la vue Bird Eye, `
        + "de préférence en face de la caméra ; Échap : retirer le départ"
      : mode === "tilt" ? "Calage de l'inclinaison : pied puis sommet de deux objets verticaux, à 90° l'un de l'autre"
      : "Mode mesure en cours : désélectionner pour naviguer";
    // Nom de la mesure et étape déjà dans l'en-tête de la carte d'étape (« Hauteur, étape 1 : »…) : retirés
    const MODE_NAMES = /^(?:Hauteur|Largeur|Mesure libre|Relevé d'objets|Longueur sur la carte|Calage de l'inclinaison)[^:]*: /;
    const tip = $("#mode-mesure").textContent.replace(MODE_NAMES, "");
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
    syncMapMeasure();
    applyMeasureUi();
    if (psv) updatePlayer();
    refresh(app.set_active(measuring));
  });

  const MARK = "mesure-";  // préfixe de nos repères, pour ne pas toucher à ceux de la visionneuse
  const PARCEL_LABEL_UP = 1.5;  // m au-dessus du sol : étiquette de la parcelle cadastrale visée
  Carte.onAim(() => showParcelMark());  // autre parcelle visée, ou autre caméra : étiquette replacée
  /** Parcelle cadastrale visée (en vert sur la carte) : section au-dessus du numéro, comme sur la mini-carte (parcelImage),
   * centrés à PARCEL_LABEL_UP m du sol au milieu de sa partie vue directement, entre ses limites gauche et droite
   * (Carte.aimedParcel). Repère à part (pas dans markIds) : replacé seul quand la parcelle visée change. */
  let parcelText = "";
  // Étiquette posée PARCEL_DELAY ms après le début du chargement d'une photo, le temps de sa HD : posée tout de suite,
  // elle sautait à l'arrivée de la HD
  const PARCEL_DELAY = 2000;
  let parcelReady = true, parcelTimer = null;
  function waitParcelTiles() {  // nouvelle photo : étiquette de la précédente retirée
    clearTimeout(parcelTimer);
    parcelReady = false;
    showParcelMark();
    parcelTimer = setTimeout(() => { parcelReady = true; showParcelMark(); }, PARCEL_DELAY);
  }
  function showParcelMark() {
    const markers = psv?.getPlugin?.("markers");
    if (!markers) return;
    const id = `${MARK}parcelle`, parcel = parcelReady && $("#cadastre-visionneuse").checked ? Carte.aimedParcel() : null;
    const at = parcel && app ? JSON.parse(app.view_point(parcel.at[0], parcel.at[1], PARCEL_LABEL_UP)) : null;
    let shown = null;
    try { shown = markers.getMarker(id); } catch { /* pas encore posée */ }
    if (!at) {
      if (shown) markers.removeMarker(id);
      updateAnnotationsButton();
      return;
    }
    const text = `${parcel.section}|${parcel.numero}`;
    const config = { id, position: at, anchor: "center center", zIndex: OVERLAY_LABEL_Z,
      tooltip: { content: `Parcelle cadastrale ${escapeHtml(parcel.section)} ${escapeHtml(parcel.numero)}, à 1,50 m du sol`,
        position: "top center" },
      html: `<div class="parcelle-visee"><span>${escapeHtml(parcel.section)}</span><span>${escapeHtml(parcel.numero)}</span></div>` };
    if (!shown) markers.addMarker(config);
    else markers.updateMarker(text === parcelText ? { id, position: at } : config);  // même parcelle : position seule
    parcelText = text;
    updateAnnotationsButton();
  }
  let markIds = [];
  let currentMarks = [];
  let measureShown = false;  // mesure (valeur en mètres) sur la photo affichée (drawViewerMarks)
  /** « Avec annotations » : actif dès qu'une annotation est dans la visionneuse (mesure, étiquette de la parcelle visée,
   * objet de la couche affichée). */
  function updateAnnotationsButton() {
    const parcel = (() => { try { return Boolean(psv?.getPlugin?.("markers")?.getMarker(`${MARK}parcelle`)); } catch { return false; } })();
    $("#vignette").disabled = !photo || !(measureShown || parcel || markIds.some((id) => id.startsWith(`${MARK}couche-`)));
  }

  function drawViewerMarks(marks) {
    currentMarks = marks;
    crossAt = app ? JSON.parse(app.pick_points()) : [];
    // « Avec annotations » : mesure (valeur en mètres) sur la photo affichée, parcelle visée, couche
    measureShown = marks.some((m) => !m.guide && /\d m\b/.test(m.label || ""));
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
      const hidden = overlayHiddenTest();
      for (const o of JSON.parse(app.overlay_marks())) {
        const p = overlay.features[o.id]?.properties || {};
        if (hidden(overlay.features[o.id])) continue;  // valeur masquée dans la légende, ou hors du filtre
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
            html: `<div class="ancre"><div class="etiquette couche dessus${chosen}" data-objet="${o.id}" data-rang="${rank++}" `
              + `style="color:${Couche.clair(color)}">${escapeHtml(p._etiquette)}</div></div>` });
        }
      }
    }
    showParcelMark();
    updateAnnotationsButton();
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
      const label = choice.expect == null ? choice.label : `${choice.label} · ±${m(choice.expect)} m${choice.across ? " en travers" : ""}`;
      const title = choice.expect == null ? choice.title
        : `${choice.title}. Incertitude attendue ${choice.across ? "en travers de la route" : "du point"} : `
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
    syncMapMeasure();
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
    if (Dessus.cancelStart()) {
      refresh();
      return applyMeasureUi();
    }
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
  for (const id of ["#depuis", "#type", "#gps", "#producteur"]) $(id).addEventListener("change", () => {
    applyFilter();
    updatePlayer();  // parcours gardé rouvert : modifié (« ☆ Enregistrer… »)
  });

  // Exports ----------------------------------------------------------------------------------

  let exported = null;  // export GeoJSON (commentaires compris) lors du dernier export

  $("#csv").addEventListener("click", async () => {
    const geojson = app.export_geojson();
    if (await download("\ufeff" + app.export_csv(), await exportName("mesures", "csv", true), "text/csv")) exported = geojson;
    saveResults();
    showResultsInfo();
  });
  $("#geojson").addEventListener("click", async () => {
    const geojson = app.export_geojson();
    if (await download(geojson, await exportName("mesures", "geojson", true), "application/geo+json")) exported = geojson;
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
    if (json !== releveSaved || !parcours.poiTargets.size !== !n) refreshPoiTargets(json);
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
  async function sendReleve() {
    const data = JSON.parse(app.export_geojson(true));
    for (const f of data.features) {  // altitude du point visé : l'objet y est dessiné dans la photo
      if (typeof f.properties.z_ngf === "number") f.geometry.coordinates.push(f.properties.z_ngf);
    }
    const name = `Relevé du ${new Date().toLocaleDateString("fr-FR")}`;
    const n = loadOverlay(name, Couche.read(JSON.stringify(data)), "", "", true);
    setOverlayFile(null);
    setOverlayChanged(true);  // dans aucun fichier encore
    const kept = await saveOverlay();
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
    const name = Object.assign(document.createElement("input"), { type: "text", value: field.nom, className: "nom",
      placeholder: "Nom du champ (ex. distance_bord_m)" });
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
      const value = f.nom in values ? values[f.nom] : old && old.dataset.type === f.type
        ? (old.type === "checkbox" ? old.checked : old.value) : null;
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
        : all((v) => typeof v === "string" && v.length <= 40) && distinct.length <= 12
          && distinct.length * 2 <= values.length ? "liste" : "texte";
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
  $("#releve-modeles-exporter").addEventListener("click", async () => download(
    JSON.stringify({ format: MODELES_FORMAT, modeles: releveModels() }, null, 2),
    await exportName("modeles-releve", "json"), "application/json"));
  $("#releve-modeles-importer").addEventListener("click", () => $("#releve-modeles-fichier").click());
  fileInput("#releve-modeles-fichier", importModels);
  /** Modèles de champs lus d'un fichier (name : son nom), remplaçant ceux de même nom. */
  function importModels(data, name) {
    const found = readModels(data);
    const error = $("#releve-erreur");
    error.textContent = found.length ? "" : `« ${name} » ne contient aucun modèle de champs lisible.`;
    error.hidden = Boolean(found.length);
    if (!found.length) return;
    const names = new Set(found.map((m) => m.nom));
    setReleveModels([...releveModels().filter((m) => !names.has(m.nom)), ...found]);
    setStatus(`${found.length} modèle${found.length > 1 ? "s" : ""} importé${found.length > 1 ? "s" : ""} de « ${name} ».`);
  }

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
    const saved = store.set("resultats", n ? JSON.stringify({ when: Date.now(), n, exported: geojson === exported,
      csv: app.export_csv(), geojson }) : "");
    if (!saved && n) {  // stockage plein : pas de copie ancienne proposée à la prochaine ouverture comme si c'était tout
      store.set("resultats", "");
      setStatus("Résultats trop nombreux pour être gardés dans le navigateur : exportez-les avant de fermer la page.", "echec");
    }
  }
  {
    // Session précédente : gardée en mémoire seulement, retirée du navigateur avant que celle-ci
    // n'écrive ; non exportée pendant cette session, elle est oubliée à sa clôture
    let previous = null;
    try { previous = JSON.parse(store.get("resultats") || "null"); } catch { /* illisible : aucun */ }
    store.set("resultats", "");
    store.set("resultats-precedents", "");  // ancienne clé (versions du 24/10/2026)
    const session = (when) => `de la session du ${when.toLocaleDateString("fr-FR")} à `
      + `${when.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, non exporté${previous.n > 1 ? "s" : ""}`;
    if (previous && previous.n && !previous.exported) showPrevious(previous, session);
  }
  /** Résultats en lecture seule ({ when, n, csv, geojson }) : liste (tirée de l'export GeoJSON, comme en mesure libre
   * où les points et distances sont hors de la liste), dessin gris sur la carte, exports ; origin(date) : leur origine. */
  function showPrevious(previous, origin) {
    const num = (v) => (v == null ? "?" : Number(v).toLocaleString("fr-FR", { maximumFractionDigits: 2 }));
    const geojson = JSON.parse(previous.geojson);
    $("#precedents ol").replaceChildren(...geojson.features.map(({ properties: p }) => {
      const text = p.type === "point triangulé" ? `Point ${p.nom} ±${num(p.incert_m)} m`
        : p.type.startsWith("distance") ? `${p.points} ${num(p.valeur_m)} m ± ${num(p.incert_m)} m`
        : `${p.type[0].toUpperCase()}${p.type.slice(1)} : ${num(p.valeur_m)} m ± ${num(p.incert_m)} m`;
      return Object.assign(document.createElement("li"), { textContent: text + (p.commentaire ? ` — ${p.commentaire}` : "") });
    }));
    Carte.showPrevious(map, geojson);
    $("#precedents summary").textContent = `${previous.n} résultat${previous.n > 1 ? "s" : ""} ${origin(new Date(previous.when))}`;
    $("#precedents").hidden = false;
    // onclick : un seul gestionnaire, remplacé quand d'autres résultats viennent (dossier de travail)
    $("#precedents-csv").onclick = async () => download("\ufeff" + previous.csv,
      await exportName("mesures-precedentes", "csv"), "text/csv");
    $("#precedents-geojson").onclick = async () => download(previous.geojson, await exportName("mesures-precedentes", "geojson"),
      "application/geo+json");
    $("#precedents-oublier").onclick = () => {
      $("#precedents").hidden = true;
      Carte.showPrevious(map, null);
    };
  }
  // Dossier de travail : tout ce qui est gardé dans ce navigateur en un fichier (couche et réglages, relevé, calage,
  // parcours, favoris, modèles de champs, photo ouverte), pour passer la main ou sauvegarder la séance. Sans les mesures :
  // reprises en lecture seule, elles n'avaient pas de sens (second bord d'une largeur affiché seul, 15/11/2026) ; à y
  // mettre avec leur reprise modifiable (pour plus tard, docs/analyses/pistes-partage.md). Réglages personnels non repris.
  const DOSSIER_FORMAT = "web-measures/dossier";
  const releveCount = () => JSON.parse(app.releve_json()).points.length;
  const calibrationCount = (c) => ["verticals", "landmarks", "heights", "auto"].reduce((t, k) => t + Object.keys(c?.[k] || {}).length, 0);
  /** « Exporter le dossier » grisé tant qu'il n'y a rien à y mettre (à l'ouverture des réglages, et après un import). */
  function showFolderExport() {
    $("#dossier-exporter").disabled = !app || !(overlay || releveCount()
      || calibrationCount(JSON.parse(app.calibration_json())) || savedRoutes().length || favorites().length || releveModels().length);
  }
  /** Dossier de travail (objet du fichier) : seules les parties non vides. */
  function workFolder() {
    const calibration = JSON.parse(app.calibration_json());
    return { format: DOSSIER_FORMAT, version: 1, date: new Date().toISOString(),
      ...(overlay && { couche: overlaySaved() }),
      ...(releveCount() && { releve: { objets: JSON.parse(app.releve_json()), champs: releveFields() } }),
      ...(calibrationCount(calibration) && { calage: calibration }),
      ...(savedRoutes().length && { parcours: savedRoutes() }),
      ...(favorites().length && { favoris: favorites() }),
      ...(releveModels().length && { modeles: releveModels() }),
      ...(photo && { photo: photo.id }) };
  }
  $("#dossier-exporter").addEventListener("click", async () => {
    if (await download(JSON.stringify(workFolder()), await exportName("dossier", "json", true), "application/json")) {
      setStatus("Dossier de travail exporté : à importer sur un autre poste (Réglages, ou glissé sur la page).");
    }
  });
  $("#dossier-importer").addEventListener("click", () => $("#dossier-fichier").click());
  fileInput("#dossier-fichier", (data, name) => notice(`« ${name} » n'est pas un dossier de travail.`));

  /** Dossier de travail lu (name : nom du fichier) : une case par partie, avec ce qu'elle fera ; ce qui remplacerait
   * du travail en cours (couche, relevé) décoché par défaut ; parties cochées reprises. */
  async function importFolder(d, name) {
    const n = (k, one, many = `${one}s`) => `${k} ${k > 1 ? many : one}`;
    const releveNow = releveCount();
    const parts = [
      d.couche?.features?.length
        && { key: "couche", checked: !overlay, text: `Couche « ${d.couche.name} » (${n(d.couche.features.length, "objet")})`,
        help: overlay ? `remplacera votre couche « ${overlay.name} »` : "deviendra votre couche",
        apply: () => {
          applySavedOverlay(d.couche, true);
          setOverlayFile(null);
          setOverlayChanged(true);  // dans aucun fichier de ce poste
          saveOverlay();
        } },
      d.releve?.objets?.points?.length
        && { key: "releve", checked: !releveNow, text: `Relevé (${n(d.releve.objets.points.length, "objet")})`,
        help: releveNow ? `remplacera votre relevé (${n(releveNow, "objet")})` : "deviendra votre relevé",
        apply: () => {
          refresh(app.clear_releve());
          store.set("releve-champs", JSON.stringify(d.releve.champs || []));
          refresh(app.load_releve(JSON.stringify(d.releve.objets)));
        } },
      calibrationCount(d.calage) && { key: "calage", checked: true,
        text: `Calage (${n(calibrationCount(d.calage), "photo ou séquence", "photos ou séquences")})`,
        help: "complétera le vôtre", apply: () => importCalibration(JSON.stringify(d.calage)) },
      d.parcours?.length && { key: "parcours", checked: true, text: n(d.parcours.length, "parcours", "parcours"),
        help: "ajoutés aux vôtres", apply: () => importRoutes({ parcours: d.parcours }) },
      d.favoris?.length && { key: "favoris", checked: true, text: n(d.favoris.length, "favori"),
        help: "ajoutés aux vôtres", apply: () => importFavorites(d.favoris) },
      d.modeles?.length && { key: "modeles", checked: true, text: n(d.modeles.length, "modèle de champs", "modèles de champs"),
        help: "ajoutés aux vôtres (même nom : remplacé)", apply: () => importModels({ format: MODELES_FORMAT, modeles: d.modeles }, name) },
      // mesures d'un dossier exporté avant le 15/11/2026 au soir : ignorées (voir plus haut)
      d.photo && UUID.test(d.photo) && { key: "photo", checked: true, text: "Photo ouverte dans le dossier", help: "rouverte",
        apply: () => goToPhoto(d.photo) },
    ].filter(Boolean);
    if (!parts.length) return notice(`Dossier « ${name} » vide : rien à reprendre.`);
    const dialog = $("#importer-dossier");
    const when = new Date(d.date);
    const dated = Number.isNaN(when.getTime()) ? "" : `, du ${when.toLocaleDateString("fr-FR")}`;
    dialog.querySelector("p").textContent = `« ${name} »${dated}. Parties à reprendre :`;
    dialog.querySelector("ul").replaceChildren(...parts.map((part) => {
      const li = document.createElement("li"), label = document.createElement("label");
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: part.checked, value: part.key });
      const text = Object.assign(document.createElement("span"), { textContent: part.text });
      text.append(Object.assign(document.createElement("span"), { className: "aide", textContent: part.help }));
      label.append(box, text);
      li.append(label);
      return li;
    }));
    dialog.returnValue = "";
    const chosen = await new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "importer"
        ? [...dialog.querySelectorAll("input:checked")].map((b) => b.value) : []), { once: true });
      showOverViewer(dialog);
    });
    const done = parts.filter((p) => chosen.includes(p.key));
    for (const part of done) part.apply();
    showFolderExport();
    if (done.length) setStatus(`Dossier « ${name} » repris : ${done.map((p) => p.text.replace(/ \(.*\)$/, "")).join(", ")}.`);
  }

  $("#calage-exporter").addEventListener("click", async () => download(app.calibration_json(), await exportName("calage", "json"),
    "application/json"));
  $("#calage-importer").addEventListener("click", () => $("#calage-fichier").click());
  fileInput("#calage-fichier", (data, name, text) => importCalibration(text));
  /** Calage lu d'un fichier (texte JSON), complétant celui en mémoire. */
  function importCalibration(text) {
    const added = app.merge_calibration(text);
    refresh(added < 0 ? "Fichier de calage illisible." : added === 0
      ? "Calage importé : rien de nouveau (photos et séquences déjà calées)."
      : `Calage importé pour ${added} photo${added > 1 ? "s" : ""} ou séquence${added > 1 ? "s" : ""}.`);
  }

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
        }, { fileName: handle.name, handle });  // nom choisi, rappelé à l'utilisateur (le dossier n'est pas connu de la page)
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
  /** Nom d'un fichier exporté : sorte, route et PR de la photo affichée (place, s'ils sont lus en 0,5 s), date du jour ;
   * « mesures D974 PR12 2026-11-15.csv ». */
  async function exportName(kind, ext, place = false) {
    const timeout = new Promise((resolve) => setTimeout(resolve, 500));  // le geste qui autorise l'enregistrement dure 5 s
    const parts = place && photo ? (await Promise.race([Lieu.describe(...photo.geometry.coordinates.slice(0, 2), photo), timeout])
      .catch(() => null))?.parts : null;
    const date = new Date().toLocaleDateString("sv-SE");  // AAAA-MM-JJ, à l'heure locale
    return `${[kind, parts?.voie, parts?.pr, date].filter(Boolean).join(" ").replace(/[\\/:*?"<>|]/g, "-")}.${ext}`;
  }
  async function download(content, name, type) {
    const save = await saveAs(name, type);
    if (save) await save(content);
    return Boolean(save);
  }

  window.addEventListener("beforeunload", (event) => {
    if (app && app.has_results() && app.export_geojson() !== exported) event.preventDefault();  // non exportés
  });

  // Captures et fiches PDF : src/fiche.js (Fiche)
  Fiche.init({
    get app() { return app; }, get photo() { return photo; }, get psv() { return psv; }, get overlay() { return overlay; },
    map, mapBox, setStatus, noticeInFullscreen, escapeHtml, placeMarkup, saveAs, viewFov, viewHeading, frameView,
    showOverViewer, openPhotoReady, loadRanks, overlayObjectName, overlayFicheData, overlayHiddenTest, overlayEnds,
    overlayPoints, saveOverlay,
  });

  // Pour les essais depuis la console : window.mesures.app.click(yaw, pitch)
  window.mesures = {
    refresh, map, openPhoto, buildFiche, paginateFiche, photoAtOffset, importOverlay, thumbnail,
    get app() { return app; }, get psv() { return psv; }, get videoPlan() { return parcours.videoPlan; },
    overlayFile: (handle) => { overlay.fichier = handle; },  // fichier de la couche remplacé (essais)
    // couche gardée (essais)
    savedOverlay: async () => {
      await overlaySaving;
      return JSON.parse(await fileStore("readonly", (s) => s.get("couche-texte")) ?? "null");
    } };
})();
