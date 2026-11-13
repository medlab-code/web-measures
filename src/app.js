// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Page de mesure : la carte choisit la photo, la visionneuse Panoramax reçoit les clics,
// le cœur de calcul du plugin (Pyodide, voir calcul.js) fait les mesures et les calages.
// Mêmes fonctions que le plugin QGIS Visionneuse Panoramax.

(() => {
  const $ = (selector) => document.querySelector(selector);

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
    const patient = typeof input === "string" && (init?.method || "GET") === "GET" && init?.cache !== "no-store"  // no-store : vérification d'accès, réponse immédiate
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
      const paved = Object.fromEntries(Object.entries(found.bords).filter(([, b]) => b?.comment === "enrobé").map(([side, b]) => [side, Math.abs(b.x)]));
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

  // Plein écran de la visionneuse (ticket #39) : toute la page, le reste masqué par style.css --------------

  const FULLSCREEN_IDLE = 3000;  // ms : souris immobile, boutons et étiquettes s'effacent
  let idleTimer = null;
  function wakeFullscreen() {
    document.documentElement.classList.remove("souris-immobile");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.documentElement.classList.add("souris-immobile"), FULLSCREEN_IDLE);
  }
  $("#plein-ecran").addEventListener("click", () => {
    const change = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    change.catch((error) => setStatus(`Plein écran impossible : ${error.message}`, "echec"));
  });
  document.addEventListener("fullscreenchange", () => {
    const full = Boolean(document.fullscreenElement), button = $("#plein-ecran");
    button.setAttribute("aria-pressed", String(full));
    button.title = full ? "Quitter le plein écran (Échap)" : "Afficher la visionneuse en plein écran";
    clearTimeout(idleTimer);
    window.removeEventListener("pointermove", wakeFullscreen, true);
    if (full) {
      setSwapped(false);  // colonne masquée, carte comprise
      window.addEventListener("pointermove", wakeFullscreen, true);  // capture : la visionneuse garde ses événements
      wakeFullscreen();
    } else {
      map.resize();  // masquée pendant le plein écran
      wantSwap();
    }
    window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
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
    message.hidden = !measuring || triangulating || $("#mode").value === "carte" || !(calibrating || tilt === "attente" || manual || before);
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
    $("#effacer").disabled = !state.can_undo && !Dessus.hasStart();  // grisés quand ils n'auraient pas d'effet ; départ d'une longueur sur la carte
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

  // Vue du dessus (src/dessus.js) : photo reprojetée au sol sur la mini-carte
  let birdeyeAsked = null, birdeyeNearAsked = null, birdeyeNear = null;  // photo dont l'inclinaison, les voisines ont été demandées ; fiches de ses voisines (null : en lecture)
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
    inMap("#dessus-fine").disabled = inMap("#dessus-voisines").disabled = inMap("#dessus-position").disabled = inMap("#dessus-bords").disabled = inMap("#dessus-sans-cache").disabled = !on;
    if (!on) inMap("#dessus-verticales").disabled = inMap("#dessus-devers").disabled = inMap("#dessus-tangage").disabled = inMap("#dessus-tangage-force").disabled = true;  // allumée : selon la vue (Dessus)
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
    measureButton.hidden = birdeyeButton.hidden = captureButton.hidden = !on && !mapWindow;  // carte en grand ou détachée : mesure et Bird Eye d'un clic
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
    onAdd: () => Object.assign(document.createElement("div"), { className: "maplibregl-ctrl maplibregl-ctrl-group" }).appendChild(swapButton).parentNode,
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
    textContent: "📷", title: "Capture de la carte : vue Bird Eye et mesures, en image PNG", ariaLabel: "Capture de la carte" });
  captureButton.addEventListener("click", async () => {
    captureButton.disabled = true;
    try {
      const blob = await Carte.capture(map), url = URL.createObjectURL(blob), stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      Object.assign(document.createElement("a"), { href: url, download: `bird-eye-${(photo?.id || "carte").slice(0, 8)}-${stamp}.png` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      console.warn("Capture de la carte :", error);
    } finally {
      showMapMeasureButton();
    }
  });
  map.addControl({
    onAdd: () => {
      const place = Object.assign(document.createElement("div"), { className: "maplibregl-ctrl place-mesurer" });
      place.append(measureButton, birdeyeButton, captureButton);
      return place;
    },
    onRemove: () => {},
  }, "top-left");
  /** Bouton de la carte en grand : enfoncé pendant la mesure, grisé sans photo 360° (pas de vue du dessus). */
  function showMapMeasureButton() {
    const on = measuring && $("#mode").value === "carte";
    measureButton.setAttribute("aria-pressed", String(on));
    measureButton.textContent = on ? "📏 Arrêter la mesure" : "📏 Mesurer une longueur";
    measureButton.title = on ? "Arrêter la mesure de longueur sur la carte" : "Mesurer une longueur sur la vue Bird Eye : deux clics sur la carte";
    measureButton.disabled = !on && ($("#dessus").disabled || $("#mode").disabled);
    const bird = $("#dessus").checked;
    birdeyeButton.setAttribute("aria-pressed", String(bird));
    birdeyeButton.disabled = $("#dessus").disabled;
    captureButton.disabled = !bird || $("#dessus").disabled;  // rien de Bird Eye à capturer
    birdeyeButton.title = bird ? "Éteindre la vue Bird Eye" : "Vue Bird Eye de cette photo (calculée pour elle seule : une autre photo l'éteint)";
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
    if (!travelPick && poi.zone && map.getLayer(ZONE_ID) && map.queryRenderedFeatures(
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
    if (event.key === "Escape" && Dessus.cancelStart()) applyMeasureUi();  // départ d'une longueur sur la carte
    if (event.key === "Escape" && lineDraft !== null) {
      endLineDraft();
      refresh();
    }
    if (event.key === "Escape" && placing) {
      setPlacing(false);
      refresh();
    }
    if (event.key === "Escape" && travelPick) {
      poi.draft = null;  // tracé de la zone ou de la planète interrompu
      planetDraft = null;
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
    measureButton.hidden = birdeyeButton.hidden = captureButton.hidden = !detached && !swapped;  // détachée : comme en grand
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
    $("#capture-hd").disabled = !Calcul.hasWorker();  // « Avec les mesures » : selon les mesures (drawViewerMarks)
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
  // sur 2, 4, 8 ou 16 (image SD comme en 1x), les autres jamais chargées ; leur liste vient de l'instance de la photo, par
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
  // 📍 de l'onglet « Vidéo » : point attendu sur la carte (« start », « end », « roll » : tonneau, « planet » : petite
  // planète, « poiZone » : zone de
  // l'effet du point d'intérêt ; petite planète et zone : en deux clics)
  let travelPick = null;
  let planetDraft = null;
  let chainedPick = false;  // arrivée demandée d'elle-même après le départ : son 📍 la garde au lieu de l'annuler  // premier clic du tronçon de petite planète en cours de tracé (LngLat ou null)
  // Endroits posés pour la vidéo, par sorte (« roll ») : [{ lonlat, marker, end }] (repère sur la carte ; un clic dessus
  // le retire ; end : fin du tronçon de la petite planète, lonlat en étant le début) ; css : classe du repère, label : nom, check : interrupteur de l'option, note : rappel à la pose
  const placed = {
    roll: { points: [], css: "tonneau", label: ["tonneau", "tonneaux"], check: "#video-tonneau",
      note: "sens alterné dans l'ordre du parcours, à moins de 30 m de lui" },
    planet: { points: [], css: "planete", label: ["petite planète", "petites planètes"], check: "#video-planete",
      note: "tronçon de l'effet, extrémités à moins de 30 m du parcours" },
    slow: { points: [], css: "ralenti", label: ["ralentissement", "ralentissements"], check: "#video-ralenti",
      note: "à moins de 30 m du parcours" },
    stop: { points: [], css: "arret", label: ["arrêt", "arrêts"], check: "#video-arret",
      note: "à moins de 30 m du parcours ; ralentir, s'arrêter, repartir" },
    waypoint: { points: [], css: "etape", label: ["étape", "étapes"], check: "#parcours-etapes",
      note: "la vidéo y passe, dans l'ordre de pose des étapes" },
    tour: { points: [], css: "tour", label: ["tour d'horizon", "tours d'horizon"], check: "#video-tour",
      note: "sens alterné, à moins de 30 m du parcours, arrêt sur la photo la plus proche" },
  };
  // Point d'intérêt (un seul ; cible : objet du relevé, liste #interet-cible) : zone de l'effet tracée sur la carte
  // ([[lon, lat], [lon, lat]] ou null), premier clic du tracé en cours (LngLat ou null)
  const poi = { zone: null, draft: null };
  // Vidéo : parcours préparé (planPhotos : { photos, switches, dates, warning, title }), sa préparation ou son calcul en
  // cours ; videoReady : départ et arrivée connus (onglet « Vidéo »)
  let videoPlan = null, videoPreparing = false, videoRun = null, videoReady = false;
  let tracing = false;  // « Tracer sur la carte » : clics enchaînés (départ, arrivée, étapes) jusqu'à Échap
  let planTimer = null, planTimerKey = "", planError = null;  // recherche des photos à venir ; planError : { key, text } de la dernière en échec
  let bandeauKey = "", seamMarkers = [];  // bandeau du parcours (showVideoPlan) : son état, repères des raccords
  const VIDEO_PLAN_DELAY = 800;  // ms : recherche des photos après le dernier changement du parcours
  const VIDEO_STALL = 30, VIDEO_GIVE_UP = 300;  // s sans image calculée : avertissement, puis arrêt de la vidéo
  const videoOk = Video.supported();
  // Format de la vidéo : grille codec × définition, au-dessus des listes #video-codec et #video-definition (cachées, gardées
  // dans les réglages du parcours). Encodeurs testés à la première ouverture de l'onglet : une image par format
  const FORMAT_NAMES = { vp9: "VP9", h264: "H.264", h265: "H.265" };
  const FORMAT_ORDER = ["h264", "vp9", "h265"];  // format pris quand celui demandé n'est pas disponible
  let videoFormats = null;  // encodeur par format (Video.encoderChoices), null avant le test
  const formatGrid = $("#video-formats");
  for (const [format, name] of Object.entries(FORMAT_NAMES)) {
    formatGrid.append(Object.assign(document.createElement("span"), { textContent: name }));
    for (const option of $("#video-definition").options) {
      const button = Object.assign(document.createElement("button"), { type: "button", textContent: option.text, disabled: true });
      Object.assign(button.dataset, { format, height: option.value });
      button.addEventListener("click", () => {
        $("#video-codec").value = format;
        $("#video-definition").value = option.value;
        updatePlayer();
      });
      formatGrid.append(button);
    }
  }
  /** Format disponible le plus proche de la définition height : [codec, définition] ; null sans aucun. */
  function nearestFormat(height) {
    for (const h of [height, ...[...$("#video-definition").options].map((o) => o.value)]) {
      const format = FORMAT_ORDER.find((f) => videoFormats[`${f}-${h}`]);
      if (format) return [format, h];
    }
    return null;
  }
  /** Format demandé indisponible (parcours gardé sur un autre poste, Firefox sous Linux sans H.264) : le plus proche. */
  function keepFormat() {
    if (!videoFormats || videoFormats[`${$("#video-codec").value}-${$("#video-definition").value}`]) return;
    const near = nearestFormat($("#video-definition").value);
    if (near) [$("#video-codec").value, $("#video-definition").value] = near;
  }
  function updateFormats() {
    const draft = $("#video-brouillon").checked;
    for (const button of formatGrid.querySelectorAll("button")) {
      const { format, height } = button.dataset, encoder = videoFormats?.[`${format}-${height}`];
      button.dataset.encodeur = encoder || "";
      button.disabled = Boolean(videoRun) || draft || !encoder;
      button.setAttribute("aria-pressed", String($("#video-codec").value === format && $("#video-definition").value === height));
      button.title = `${FORMAT_NAMES[format]}, ${height}p : ${!videoFormats ? "test de l'encodeur en cours"
        : !encoder ? "pas disponible sur ce poste" : encoder === "materiel" ? "encodeur matériel" : "encodeur logiciel, plus lent"}${draft ? " (brouillon : toujours 960 × 540)" : ""}`;
    }
  }
  new IntersectionObserver(([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    Video.encoderChoices().then((choices) => {
      videoFormats = choices;
      // Valeurs de la page (remise à zéro, choix du mode) : un format que le poste encode
      const [format, height] = nearestFormat("1080") || ["h264", "1080"];
      for (const [select, value] of [[$("#video-codec"), format], [$("#video-definition"), height]]) {
        const kept = select.value;
        for (const option of select.options) option.defaultSelected = option.value === value;
        select.value = kept;
      }
      keepFormat();
      updatePlayer();
    });
  }).observe($("#parcours"));
  const TILES_WAIT = 4000;  // ms : attente au plus des tuiles HD d'une vue du parcours (réseau lent)
  const TOUR_REACH = 40;  // m : photos du départ et de l'arrivée cherchées à cette distance (même séquence)
  const TOUR_END = 30;  // m : hors de la séquence de l'arrivée, arrivée passée quand la distance remonte sous ce seuil
  const TOUR_AWAY = 40;  // m : séquence qui s'écarte d'autant de son point le plus proche de l'arrivée : rebranchement
  const TOUR_BRANCH = 25;  // m : séquences cherchées autour de ce point pour s'y rebrancher
  const TOUR_PASS = 10;  // m : séquences d'arrivée : celles qui y passent à moins de la plus proche + TOUR_PASS
  const TOUR_PATH = 100;  // rangs (500 m) du tracé des séquences d'arrivée lus de part et d'autre de l'arrivée
  const TOUR_JOIN = 10;  // m : photo lue sur le tracé d'une séquence d'arrivée à moins de cette distance
  const TOUR_LEAP = 30;  // m : écart au plus entre les deux photos d'une bifurcation (trajectoire lisse d'abord)
  const TOUR_CANDIDATES = 5;  // séquences de départ comparées au plus (vidéo)
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

  const { sequenceApis } = Services;

  function play(back, k) {
    stopPlayer();
    follow.held = false;  // nouvelle lecture : la carte suit de nouveau
    backward = back;
    speed = k;
    const rank = Number(photo?.properties?.["geovisio:rank_in_collection"]);
    const apis = photo?.collection ? sequenceApis(photo) : [];
    if (k === 1 || !Number.isInteger(rank) || !apis.length) {
      if (k !== 1) console.warn("Lecture rapide impossible (rang ou instance de la photo inconnus) : 1x");
      speed = 1;
      psv.playSequence(back);
      return;
    }
    fast = { collection: photo.collection, apis, rank, step: back ? -k : k, id: photo.id, ids: new Map(), points: new Map(),
      timer: null };
    // Comme en 1x : la visionneuse se croit en lecture (shouldGoFast) et charge l'image SD sans transition, la HD
    // seulement à l'arrêt (stopSequence, appelé par stopPlayer : forceRefresh)
    psv._sequencePlaying = back ? -1 : 1;
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
        // startAfterRank : 1 au moins (0 ou moins : HTTP 400), sinon depuis la première photo de la séquence
        const response = await fetch(`${run.apis[0]}/items?limit=${WINDOW}${start >= 1 ? `&startAfterRank=${start}` : ""}`);
        if (!response.ok) {
          const detail = await response.json().then((d) => d.message).catch(() => "");
          if (response.status === 404 && /last available rank/.test(detail)) return;  // au-delà de la fin de la séquence
          throw new Error(`Panoramax, photos de la séquence ${(run.collection || "").slice(0, 8)} : HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
        }
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
      stopPlayer();
      return;
    }
    run.rank = target;
    run.id = run.ids.get(target);
    viewer.select(run.collection, run.id, true);
  }

  /** Valeur EXIF « 31072/100 » ou « 310.72 » en nombre, ou null. */
  function exifNumber(text) {
    const [n, d = 1] = String(text ?? "").split("/").map(Number);
    return text != null && Number.isFinite(n / d) && d ? n / d : null;
  }

  const rankOf = (f) => Number(f.properties?.["geovisio:rank_in_collection"]);
  const angleBetween = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

  /**
   * Départ du parcours de start à end, pour la vidéo (planPhotos) : séquences qui
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
    // Tracé des séquences d'arrivée, TOUR_PATH rangs de part et d'autre de l'arrivée : bifurcation au carrefour
    const paths = new Map();
    await Promise.all(endPhotos.map(async (f) => {
      const path = { apis: sequenceApis(f), step: 1, ids: new Map(), points: new Map(), collection: f.collection };
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
    // Séquences de départ possibles (une photo par séquence, la plus proche ; celles qui passent à l'arrivée d'abord),
    // comparées par planPhotos : TOUR_CANDIDATES au plus
    const candidates = [];
    for (const f of [...common, ...near]) {
      if (candidates.length >= TOUR_CANDIDATES || candidates.some((c) => c.feature.collection === f.collection)) continue;
      const choice = endRanks.has(f.collection) && rankOf(f) !== endRanks.get(f.collection)
        ? { feature: f, back: endRanks.get(f.collection) < rankOf(f) } : towardEnd([f], end);
      if (choice) candidates.push(choice);
    }
    return { t, first, back, candidates, warning: common.length ? "" : "Pas de séquence unique du départ à l'arrivée : le parcours "
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
   * Décision du parcours t à la photo here (rang run.rank) : { action, join,
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

  /**
   * Photos du parcours de start à end pour la vidéo, de proche en proche (secours de planLegs, sans itinéraire) : mêmes
   * décisions que la lecture (tourPlan, tourDecide, branchTarget), rang après rang (toutes les photos des séquences
   * parcourues) ; plusieurs séquences au départ : chacune est essayée, celle qui fait le moins de changements est
   * retenue. Rend { photos [Video.record], switches, dates, warning } ; erreur (texte) si le parcours est impossible.
   */
  async function planPhotos(start, end) {
    const plan = await tourPlan(start, end);
    if (plan.error) throw new Error(plan.error);
    const fresh = () => ({ ...plan.t, best: Infinity, bestAt: null, used: new Set(), switches: 0, dates: new Set() });
    if (plan.candidates.length < 2) return walkPhotos(plan, fresh(), plan.first, plan.back);
    const trials = [];
    for (const [k, c] of plan.candidates.entries()) {
      setStatus(`Vidéo : comparaison des séquences de départ (${k + 1} / ${plan.candidates.length})…`);
      const result = await walkPhotos(plan, fresh(), c.feature, c.back).catch(() => null);
      if (result) trials.push(result);
    }
    trials.sort((a, b) => a.switches - b.switches);  // tri stable : ordre de tourPlan
    return trials[0] || walkPhotos(plan, fresh(), plan.first, plan.back);  // échec : son message
  }

  /** Photos du parcours t (tourPlan plan) depuis la photo first (à rebours si back) : voir planPhotos. */
  async function walkPhotos(plan, t, first, back) {
    const photos = [];
    let run = null, bestIndex = 0;
    const begin = (collection, apis, rank, sign, ids = new Map(), points = new Map()) => {
      t.used.add(collection);
      t.endRank = t.endRanks.get(collection) ?? null;
      t.best = Infinity;
      t.bestAt = null;
      run = { apis, step: sign, rank, ids, points, collection };
    };
    begin(first.collection, sequenceApis(first), rankOf(first), back ? -1 : 1);
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

  /**
   * Photos du parcours de start à end par ses étapes (placed.waypoint, dans l'ordre de pose) : itinéraire routier de la
   * Géoplateforme par ces points (routeLine), photos choisies le long de son tracé (planAlongLine) ; une étape impose un
   * passage que l'itinéraire n'aurait pas pris. Secours (service muet, aucune photo le long) : de proche en proche d'un
   * point au suivant (planPhotos), tronçons mis bout à bout (photo commune une seule fois, changement de séquence compté
   * entre deux tronçons). Même forme de résultat que planPhotos.
   */
  async function planLegs(start, end) {
    const points = [start, ...placed.waypoint.points.map((p) => p.lonlat), end];
    setStatus("Vidéo : itinéraire (Géoplateforme IGN)…");
    const route = await routeLine(points).catch((error) => { console.warn("Vidéo :", error); return null; });
    const along = route && await planAlongLine(route, "l'itinéraire");
    if (along) return along;
    const out = { photos: [], switches: 0, dates: [], warning: "" };
    for (let k = 1; k < points.length; k++) {
      if (points.length > 2) setStatus(`Vidéo : recherche des photos, tronçon ${k} / ${points.length - 1}…`);
      let leg;
      try {
        leg = await planPhotos(points[k - 1], points[k]);
      } catch (error) {
        throw points.length > 2 ? new Error(`${k === 1 ? "du départ" : `de l'étape ${k - 1}`} à `
          + `${k === points.length - 1 ? "l'arrivée" : `l'étape ${k}`} : ${error.message}`) : error;
      }
      const last = out.photos.at(-1);
      if (last && leg.photos[0]?.id === last.id) leg.photos.shift();
      if (last && leg.photos[0] && leg.photos[0].collection !== last.collection) out.switches++;
      out.photos.push(...leg.photos);
      out.switches += leg.switches;
      out.dates = [...new Set([...out.dates, ...leg.dates])].sort();
      out.warning ||= leg.warning;
    }
    return out;
  }

  /** Itinéraire routier de la Géoplateforme (Valhalla sur la BD TOPO, voiture, le plus rapide) par les points
   * [lon, lat] (départ, étapes, arrivée) : [[lon, lat]…], ou null. */
  async function routeLine(points) {
    const at = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    const params = new URLSearchParams({ resource: "bdtopo-valhalla", profile: "car", optimization: "fastest",
      start: at(points[0]), end: at(points[points.length - 1]), geometryFormat: "geojson", getSteps: "false", getBbox: "false" });
    if (points.length > 2) params.set("intermediates", points.slice(1, -1).map(at).join("|"));
    const response = await fetch(`${Carte.GEOPF}/navigation/itineraire?${params}`);
    if (!response.ok) throw new Error(`itinéraire IGN : HTTP ${response.status}`);
    const line = (await response.json()).geometry?.coordinates;
    return Array.isArray(line) && line.length > 1 ? line.map((p) => p.slice(0, 2)) : null;
  }

  /**
   * Photos du parcours le long du tracé line ([[lon, lat]…], itinéraire ; label : son nom dans la ligne d'état) : tous
   * les ALONG_STEP m, photos à ALONG_NEAR m au plus, prises dans le sens de la marche
   * (ou à l'opposé, lues à rebours) à ALONG_ANGLE° près ; choix de la séquence (et du sens) à chaque pas, sur tout le
   * parcours d'un coup (programmation dynamique), par ordre d'importance : le sens (chaque pas lu à rebours coûte
   * ALONG_BACK, l'arrière du véhicule se retrouvant à l'avant de la vidéo), puis la proximité dans le temps et le nombre
   * des changements (un changement : 1, plus 1 par ALONG_DAYS jours d'écart entre les deux séquences) ; pas sans photo :
   * sautés. Même forme de résultat que planPhotos, plus reversed (photos lues à rebours) ; null sans photo le long.
   */
  async function planAlongLine(line, label) {
    // Points du tracé tous les ALONG_STEP m, avec le cap de la route
    const stations = [];
    for (let k = 1, carry = 0; k < line.length; k++) {
      const a = line[k - 1], b = line[k], d = metresBetween(a, b);
      if (d < 0.01) continue;
      const heading = Requeteur.bearing(a, b);
      let s = carry;
      for (; s < d; s += ALONG_STEP) stations.push({ at: [a[0] + (b[0] - a[0]) * s / d, a[1] + (b[1] - a[1]) * s / d], heading });
      carry = s - d;  // reste jusqu'au pas suivant, sur le segment d'après
    }
    // Photos le long du tracé : recherches de ALONG_CHUNK m de demi-côté, tous les ALONG_CHUNK m (4 à la fois)
    const photosById = new Map(), centres = stations.filter((_, i) => i % Math.round(ALONG_CHUNK / ALONG_STEP) === 0);
    for (let i = 0; i < centres.length; i += 4) {
      setStatus(`Vidéo : photos le long de ${label} (${Math.round(100 * i / centres.length)} %)…`);
      if ($("#video-recherche")) $("#video-recherche").value = i / centres.length;
      const found = await Promise.all(centres.slice(i, i + 4).map((c) => Carte.photosNear(map, ...c.at,
        (f) => passesFilter(f) && Number.isInteger(rankOf(f)), ALONG_CHUNK + ALONG_NEAR, 1000).catch(() => [])));
      for (const f of found.flat()) photosById.set(f.id, f);
    }
    // Photos rangées par cases de CELL degrés (une vingtaine de mètres) : chaque pas ne regarde que les cases voisines
    const CELL = 0.0002, cells = new Map(), cellOf = ([lon, lat]) => [Math.floor(lon / CELL), Math.floor(lat / CELL)];
    for (const f of photosById.values()) {
      const key = cellOf(f.geometry.coordinates).join(" ");
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(f);
    }
    const around = (at) => {
      const [i, j] = cellOf(at), out = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) out.push(...(cells.get(`${i + di} ${j + dj}`) || []));
      return out;
    };
    // Candidats de chaque pas : séquence et sens -> photo la plus proche
    const options = stations.map(({ at, heading }) => {
      const best = new Map();
      for (const f of around(at)) {
        const d = metresBetween(at, f.geometry.coordinates);
        const azimuth = Number(f.properties?.["view:azimuth"]);
        if (d > ALONG_NEAR || !Number.isFinite(azimuth)) continue;
        const back = angleBetween(azimuth, heading) < ALONG_ANGLE ? false : angleBetween(azimuth + 180, heading) < ALONG_ANGLE ? true : null;
        if (back == null) continue;
        const key = `${f.collection}|${back}`;
        if (!best.has(key) || d < best.get(key).d) best.set(key, { f, d, back });
      }
      return best;
    });
    // Programmation dynamique : coût le plus bas pour arriver à chaque pas sur chaque séquence et sens
    let cost = new Map();
    const from = [], days = new Map();  // séquence et sens -> jour de prise de vue
    for (const choice of options) {
      const next = new Map(), back = new Map();
      if (!choice.size) {  // pas sans photo : rien ne change
        from.push(null);
        continue;
      }
      for (const [key, o] of choice) {
        days.set(key, Date.parse(o.f.properties?.datetime) / 86400e3 || 0);
        const reverse = o.back ? ALONG_BACK : 0;  // lecture à rebours (l'arrière du véhicule à l'écran) : coûte à chaque pas
        // Rester sur la séquence, ou en changer : 1, plus 1 par ALONG_DAYS jours d'écart entre les deux séquences
        let best = cost.has(key) ? { c: cost.get(key), from: key } : null;
        for (const [prev, c] of cost) {
          if (prev === key) continue;
          // Raccord discret : là où les photos des deux séquences sont au même endroit (1 de plus par ALONG_SEAM m d'écart)
          const there = choice.get(prev);
          const apart = there ? metresBetween(there.f.geometry.coordinates, o.f.geometry.coordinates) : 2 * ALONG_NEAR;
          const change = c + 1 + Math.abs(days.get(prev) - days.get(key)) / ALONG_DAYS + apart / ALONG_SEAM;
          if (!best || change < best.c) best = { c: change, from: prev };
        }
        next.set(key, (best?.c ?? 0) + reverse);
        back.set(key, best?.from ?? null);
      }
      cost = next;
      from.push(back);
    }
    if (!cost.size) return null;
    // Remontée : séquence et sens retenus à chaque pas
    let key = [...cost].sort((x, y) => x[1] - y[1])[0][0];
    const chosen = Array(options.length).fill(null);
    for (let i = options.length - 1; i >= 0; i--) {
      if (!from[i]) continue;
      chosen[i] = key;
      key = from[i].get(key);
    }
    // Trajectoire virtuelle : le tracé lui-même (abscisse curviligne de ses sommets) ; chaque photo y est ramenée au
    // point le plus proche, près du pas où elle a été choisie : la vidéo avance et prend son cap le long de la route, sans
    // recul, arrêt ni balayage aux changements de séquence (photos de voies voisines, décalées de quelques mètres)
    const cum = [0];
    for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + metresBetween(line[k - 1], line[k]));
    const pointAt = (s) => {
      let k = 1;
      while (k < line.length - 1 && cum[k] < s) k++;
      const u = Math.min(1, Math.max(0, (s - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1)));
      return [line[k - 1][0] + (line[k][0] - line[k - 1][0]) * u, line[k - 1][1] + (line[k][1] - line[k - 1][1]) * u];
    };
    const projectNear = ([lon, lat], s0) => {  // { d, s } sur les segments à ± 50 m de l'abscisse s0
      const kx = 111320 * Math.cos(lat * Math.PI / 180);
      let best = { d: Infinity, s: s0 };
      for (let k = 1; k < line.length; k++) {
        if (cum[k] < s0 - 50 || cum[k - 1] > s0 + 50) continue;
        const ax = (line[k - 1][0] - lon) * kx, ay = (line[k - 1][1] - lat) * 111320;
        const dx = (line[k][0] - line[k - 1][0]) * kx, dy = (line[k][1] - line[k - 1][1]) * 111320;
        const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) || 1)));
        const d = Math.hypot(ax + u * dx, ay + u * dy);
        if (d < best.d) best = { d, s: cum[k - 1] + u * (cum[k] - cum[k - 1]) };
      }
      return best;
    };
    // Photos retenues, dans l'ordre ; dans une même séquence, rangs croissants (décroissants à rebours) ; photos à plus de
    // ALONG_OFFSET m du tracé retirées (autre voie, mal placées)
    const out = [], dates = new Set();
    let switches = 0, last = null, reversed = 0, lastS = -Infinity;
    for (const [i, k] of chosen.entries()) {
      if (!k) continue;
      const { f, back } = options[i].get(k);
      if (last && last.key === k && (rankOf(f) - last.rank) * (back ? -1 : 1) <= 0) continue;  // déjà passée
      const on = projectNear(f.geometry.coordinates, i * ALONG_STEP);
      if (on.d > ALONG_OFFSET || on.s < lastS + 0.5) continue;  // trop loin du tracé, ou pas plus loin que la précédente
      if (last && last.key !== k) switches++;
      lastS = on.s;
      const exif = f.properties?.exif || {};
      const point = { coords: pointAt(on.s), alt: exifNumber(exif["Exif.GPSInfo.GPSAltitude"]),
        heading: exifNumber(exif["Exif.GPSInfo.GPSImgDirection"]) ?? Number(f.properties?.["view:azimuth"]) };
      const record = Video.record(f, point);
      if (back) reversed++;
      out.push(record);
      dates.add(record.date);
      last = { key: k, rank: rankOf(f) };
    }
    if (out.length < 2) return null;
    return { photos: out, switches, reversed, dates: [...dates].filter(Boolean).sort(),
      warning: switches ? "Le parcours passe d'une séquence à l'autre : les photos peuvent différer (date, lumière, sens de prise de vue)." : "" };
  }
  const ALONG_STEP = 5, ALONG_NEAR = 12, ALONG_ANGLE = 50, ALONG_CHUNK = 150;  // m, m, degrés, m
  const ALONG_BACK = 25;  // pas lu à rebours (5 m) : plus qu'un changement entre séquences à cinq ans d'écart (le sens d'abord)
  const ALONG_OFFSET = 6;  // m : photo plus loin du tracé (autre voie, mal placée) retirée
  const ALONG_SEAM = 3;  // m d'écart entre les photos des deux séquences au raccord qui valent un changement de plus
  const ALONG_DAYS = 90;  // jours d'écart entre deux séquences qui valent un changement de plus

  // Onglet « Vidéo » : photos cherchées d'elles-mêmes dès que départ et arrivée sont connus (scheduleVideoPlan)
  const travelPane = $("#parcours");
  const travelFields = Requeteur.travelForm(travelPane.querySelector(".champs-route"), map);
  const updateTravel = () => {
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
    if (!which && tracing) {
      tracing = false;
      updatePlayer();
    }
    map.getCanvas().style.cursor = which ? "crosshair" : "";
    for (const button of travelPane.querySelectorAll(".sur-carte")) {
      button.setAttribute("aria-pressed", String(button.dataset.cote === which));
    }
    if (which) {
      setStatus(`Parcours : cliquez sur la mini-carte ${{ start: "le départ", end: "l'arrivée", roll: "l'endroit du tonneau", stop: "l'endroit de l'arrêt", slow: "un point de ralentissement", waypoint: "une étape (sur une route photographiée)", planet: planetDraft ? "la fin de la petite planète" : "le début de la petite planète (le long de la route)", tour: "l'endroit du tour d'horizon",
        poiZone: poi.draft ? "la fin de la zone de l'effet" : "le début de la zone de l'effet (le long de la route)" }[which]} ; `
        + "Échap pour annuler.");
    }
  }
  const placedCount = (kind) => `${kind.points.length || "aucun"} ${kind.label[kind.points.length > 1 ? 1 : 0]}`;
  /** Endroit de la sorte which (placed) posé en lonlat (petite planète : tronçon de lonlat à end, repère au milieu) :
   * repère sur la carte (un clic dessus le retire), interrupteur de l'option activé ; rend la sorte. */
  function placePoint(which, lonlat, end = null) {
    const kind = placed[which];
    const element = Object.assign(document.createElement("div"), { className: `repere-requete ${kind.css}`,
      title: `${kind.label[0][0].toUpperCase()}${kind.label[0].slice(1)} de la vidéo (clic : le retirer)` });
    const at = end ? [(lonlat[0] + end[0]) / 2, (lonlat[1] + end[1]) / 2] : lonlat;
    const point = { lonlat, end, marker: new maplibregl.Marker({ element, anchor: "bottom" }).setLngLat(at).addTo(map) };
    element.addEventListener("click", (event) => {
      event.stopPropagation();  // pas un clic sur la carte
      point.marker.remove();
      kind.points = kind.points.filter((p) => p !== point);
      if (!kind.points.length && !(which === "planet" && $("#planete-tout").checked)) $(kind.check).checked = false;
      if (which === "waypoint") videoPlan = null;  // parcours changé : vidéo à préparer de nouveau
      setStatus(`Retiré ; ${placedCount(kind)} en tout.`);
      showPlanets();
      updatePlayer();
    });
    kind.points.push(point);
    if (which === "waypoint") videoPlan = null;
    $(kind.check).checked = true;
    showPlanets();
    updatePlayer();
    return kind;
  }
  /** Tracé enchaîné : le clic suivant pose le point which (« Tracer sur la carte »). */
  function traceNext(which) {
    setTravelPick(which);
    tracing = true;
    setStatus(`Tracé : cliquez sur la mini-carte ${{ start: "le départ", end: "l'arrivée", waypoint: "une étape, si besoin" }[which]} ; Échap pour terminer.`);
    updatePlayer();
  }
  async function pickTravelPoint(lngLat) {
    const which = travelPick, chain = tracing;
    setTravelPick(null);
    if (which === "poiZone") {  // zone de l'effet : premier clic, puis second (trait fixé) ; le parcours ne change pas
      if (!poi.draft) {
        poi.draft = lngLat;
        setTravelPick("poiZone");
        return;
      }
      poi.zone = [[poi.draft.lng, poi.draft.lat], [lngLat.lng, lngLat.lat]];
      poi.draft = null;
      showPoiZone();
      setStatus("Zone de l'effet tracée (extrémités ramenées sur le parcours, à 30 m au plus) ; clic sur le trait pour la retirer.");
      updatePlayer();
      return;
    }
    if (which === "planet" && !planetDraft) {  // petite planète : début du tronçon, puis sa fin
      planetDraft = lngLat;
      setTravelPick("planet");
      return;
    }
    if (placed[which]) {  // tonneau, petite planète… : endroit ajouté, interrupteur activé (étape : vidéo à préparer)
      const kind = which === "planet" ? placePoint(which, [planetDraft.lng, planetDraft.lat], [lngLat.lng, lngLat.lat])
        : placePoint(which, [lngLat.lng, lngLat.lat]);
      planetDraft = null;
      setStatus(`Placé : ${placedCount(kind)} en tout (${kind.note}) ; 📍 pour en ajouter, clic sur un repère pour le retirer.`);
      if (chain) traceNext("waypoint");
      return;
    }
    await travelFields.pick(which, [lngLat.lng, lngLat.lat]);
    videoPlan = null;
    updateTravel();
    if (chain) return traceNext(which === "start" ? "end" : "waypoint");
    // Départ posé sans arrivée : le clic suivant pose l'arrivée (oubli du 📍 de l'arrivée : départ déplacé à sa place)
    const t = travelFields.state();
    if (which === "start" && !t.end.point && !t.end.pr) {
      setTravelPick("end");
      chainedPick = true;
    }
  }
  // Nouveau tracé : l'ancien parcours (départ, arrivée, étapes) est remplacé ; second clic, comme Échap : fin du tracé
  $("#parcours-tracer").addEventListener("click", () => {
    if (tracing) {
      setTravelPick(null);
      setStatus("Tracé terminé.");
      return updatePlayer();
    }
    travelFields.restore({ route: "", start: {}, end: {} });
    for (const p of placed.waypoint.points) p.marker.remove();
    placed.waypoint.points = [];
    videoPlan = null;
    updateTravel();
    traceNext("start");
  });
  for (const button of travelPane.querySelectorAll(".sur-carte")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();  // 📍 du tonneau : dans la ligne de l'interrupteur, sans le basculer
      const off = travelPick === button.dataset.cote && !chainedPick;
      chainedPick = false;
      setTravelPick(off ? null : button.dataset.cote);
    });
  }
  // Vitesse de regard affichée à côté de sa réglette ; elle change la durée de la vidéo
  $("#regard-vitesse").addEventListener("input", () => {
    $("#regard-valeur").textContent = `${$("#regard-vitesse").value} km/h`;
    updatePlayer();
  });
  // Vitesse de rotation de la petite planète, durées du tonneau et de la planète affichées à côté de leur réglette
  for (const id of ["#tour-duree", "#tour-arret"]) $(id).addEventListener("input", updatePlayer);  // durée de la vidéo
  // Petite planète sur tout le parcours : option activée sans tronçon à tracer, 📍 grisé
  $("#planete-tout").addEventListener("change", () => {
    const all = $("#planete-tout").checked;
    if (all) $("#video-planete").checked = true;
    else if (!placed.planet.points.length) $("#video-planete").checked = false;
    if (all && travelPick === "planet") setTravelPick(null);
    updatePlayer();
  });
  $("#planete-transition").addEventListener("input", () => {
    const fade = Number($("#planete-transition").value);
    $("#planete-transition-valeur").textContent = fade ? `${fade} s` : "aucune";
    updatePlayer();  // tonneau des transitions grisé sans transition
  });
  $("#planete-rotation").addEventListener("input", () => {
    const speed = Number($("#planete-rotation").value);
    $("#planete-rotation-valeur").textContent = speed ? `${speed} °/s` : "sans";
  });
  for (const name of ["tonneau", "tour"]) {
    $(`#${name}-duree`).addEventListener("input", () => {
      $(`#${name}-valeur`).textContent = `${String($(`#${name}-duree`).value).replace(".", ",")} s`;
    });
  }
  // Tonneau ou point d'intérêt activé sans endroit : le choisir sur la carte
  for (const [which, kind] of Object.entries(placed)) {
    $(kind.check).addEventListener("change", () => {
      if (which === "slow" && $(kind.check).checked && !kind.points.length) return fillSlows();  // posés d'eux-mêmes
      if ($(kind.check).checked && !kind.points.length && !(which === "planet" && $("#planete-tout").checked)) setTravelPick(which);
    });
  }
  $("#video-interet").addEventListener("change", () => {
    if ($("#video-interet").checked && !$("#interet-cible").value) {
      setStatus($("#interet-aucun").textContent, "avertissement");
    }
    updatePlayer();
  });
  $("#interet-cible").addEventListener("change", updatePlayer);
  /** Liste des cibles : objets du relevé (releve_json de App), « n° 3 · premier champ » ; choix gardé s'il existe encore ;
   * sans objet, liste grisée et invitation à en relever un. */
  function refreshPoiTargets(json) {
    const select = $("#interet-cible"), kept = select.value;
    const objects = (JSON.parse(json || "null")?.points || []).map(([lon, lat, values]) => ({ lon, lat, values }));
    select.replaceChildren(...objects.map(({ lon, lat, values }) => {
      const first = Object.values(values.releve || {}).find((v) => v != null && v !== "");
      return Object.assign(document.createElement("option"), {
        value: String(values.id), textContent: `n° ${values.id} · ${first ?? `Objet ${values.nom}`}`
          + (values.z_ngf == null ? " (sans altitude)" : ""),
      });
    }));
    poiTargets = new Map(objects.map((o) => [String(o.values.id), { lonlat: [o.lon, o.lat], z: o.values.z_ngf ?? null }]));
    // Cible d'un parcours gardé qui n'est pas dans ce relevé (parcours importé) : proposée aussi
    if (poiKept) {
      select.append(Object.assign(document.createElement("option"), { value: "parcours", textContent: `${poiKept.label} (parcours gardé)` }));
      poiTargets.set("parcours", poiKept);
    }
    poiJson = json;
    if (poiTargets.has(kept)) select.value = kept;
    select.disabled = !poiTargets.size || Boolean(videoRun);
    $("#interet-aucun").hidden = Boolean(poiTargets.size);
  }
  let poiTargets = new Map();  // identifiant d'objet du relevé -> { lonlat, z (altitude NGF ou null) }
  // Cible rétablie d'un parcours gardé, absente du relevé : { lonlat, z, label } ou null ; dernier relevé de la liste
  let poiKept = null, poiJson = "";
  // Zone de l'effet sur la carte : trait tracé (plein, violet, large) et, la vidéo préparée, portion du parcours concernée
  const ZONE_ID = "zone-interet", ZONE_PATH_ID = "zone-interet-parcours";
  function showPoiZone(draftTo = null) {
    if (!map.isStyleLoaded()) {  // tuiles en cours de chargement : dessinée une fois la carte au repos
      map.once("idle", () => showPoiZone(draftTo));
      return;
    }
    const ends = poi.draft && draftTo ? [[poi.draft.lng, poi.draft.lat], [draftTo.lng, draftTo.lat]] : poi.zone;
    let section = null;
    const aim = poiOptions();
    if (aim && poi.zone && videoPlan?.photos?.length > 1) {
      try {
        const path = Video.trajectory(videoPhotos()), span = Video.poiSpan(path, aim);
        section = [];
        for (let x = span.x0; x < span.x1; x += 2) section.push(path.at(x));
        section.push(path.at(span.x1));
      } catch { /* zone loin du parcours : signalée au calcul de la vidéo */ }
    }
    const layers = [[ZONE_PATH_ID, section, { "line-color": "#8e24aa", "line-width": 7, "line-opacity": 0.75 }],
      [ZONE_ID, ends, { "line-color": "#8e24aa", "line-width": 6 }]];
    for (const [id, coordinates, paint] of layers) {
      const data = { type: "FeatureCollection", features: coordinates
        ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }] : [] };
      if (map.getSource(id)) map.getSource(id).setData(data);
      else if (coordinates) {
        map.addSource(id, { type: "geojson", data });
        map.addLayer({ id, type: "line", source: id, paint });
      }
    }
  }
  map.on("mousemove", (event) => {
    if (poi.draft) showPoiZone(event.lngLat);
    if (planetDraft) showPlanets(event.lngLat);
  });
  // Tronçons des petites planètes sur la carte (trait plein, bleu nuit), et celui en cours de tracé jusqu'au pointeur
  const PLANETS_ID = "petites-planetes";
  function showPlanets(draftTo = null) {
    if (!map.isStyleLoaded()) {
      map.once("idle", () => showPlanets(draftTo));
      return;
    }
    const lines = placed.planet.points.filter((p) => p.end).map((p) => [p.lonlat, p.end]);
    if (planetDraft && draftTo) lines.push([[planetDraft.lng, planetDraft.lat], [draftTo.lng, draftTo.lat]]);
    const data = { type: "FeatureCollection", features: lines.map((coordinates) =>
      ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } })) };
    if (map.getSource(PLANETS_ID)) map.getSource(PLANETS_ID).setData(data);
    else if (lines.length) {
      map.addSource(PLANETS_ID, { type: "geojson", data });
      map.addLayer({ id: PLANETS_ID, type: "line", source: PLANETS_ID, paint: { "line-color": "#283593", "line-width": 6, "line-opacity": 0.8 } });
    }
  }
  // Réglettes du point d'intérêt : valeur affichée ; la vitesse change la durée de la vidéo
  const poiSpeed = () => (Number($("#interet-vitesse").value) > 130 ? null : Number($("#interet-vitesse").value));
  for (const [id, text] of [["#interet-vitesse", () => (poiSpeed() ? `${poiSpeed()} km/h` : "sans ralentir")],
    ["#interet-zoom", () => `× ${String($("#interet-zoom").value).replace(".", ",")}`]]) {
    $(id).addEventListener("input", () => {
      $(`${id}-valeur`).textContent = text();
      updatePlayer();
    });
  }
  /** Réglages du point d'intérêt pour Video (cible : objet du relevé choisi, son altitude NGF z ou null ; sans les
   * altitudes du sol), ou null s'il n'est pas actif. */
  function poiOptions() {
    const target = poiTargets.get($("#interet-cible").value);
    if (!videoOption("#video-interet") || !target) return null;
    return { target: target.lonlat, z: target.z, start: poi.zone?.[0] || null, end: poi.zone?.[1] || null,
      speed: poiSpeed(), zoom: Number($("#interet-zoom").value),
      zoomByDistance: $("#interet-zoom-distance").checked, roll: $("#interet-tonneau").checked };
  }
  // Parcours gardés (onglet « Parcours ») : départ, arrivée et réglages de la vidéo (options, endroits des tonneaux et
  // des planètes, zone et cible du point d'intérêt, filtre de date), rouverts d'un clic ; export de la liste ou d'un
  // seul (pour un collègue), import ajouté à la liste
  const routeSettings = () => [$("#video-mode"), $("#video-vitesse"), $("#video-photos"), $("#video-codec"), $("#video-definition"), ...travelPane.querySelectorAll(".options input")];
  // Parcours gardé rouvert (ou venant d'être gardé) : son identifiant, et l'état de ses réglages à l'ouverture (routeSnapshot) ;
  // modifié : « ☆ Enregistrer… » propose de le remplacer dans la liste ou d'en créer un nouveau
  let openedRoute = null, openedSnapshot = "";
  const routeId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  function savedRoutes() {
    let list;
    try { list = JSON.parse(store.get("parcours", "[]")) || []; } catch { list = []; }
    return list.map((r) => (r.id ? r : { ...r, id: routeId() }));  // gardé avant les identifiants
  }
  /** Réglages du parcours en cours, sans chercher les PR (comparaison avec ceux de l'ouverture). */
  function routeSnapshot() {
    const t = travelFields.state();
    return JSON.stringify([t, routeSettings().map((e) => (e.type === "checkbox" ? e.checked : e.value)),
      Object.values(placed).map((kind) => kind.points.map(placeOf)), poi.zone,
      poiTargets.get($("#interet-cible").value)?.lonlat || null, $("#depuis").value, instance.value, $("#producteur").value]);
  }
  const placeOf = (p) => (p.end ? [p.lonlat, p.end] : p.lonlat);  // endroit gardé (petite planète : [début, fin])
  const routeChanged = () => Boolean(openedRoute) && routeSnapshot() !== openedSnapshot;
  function markOpened(id) {
    openedRoute = id;
    openedSnapshot = id ? routeSnapshot() : "";
    showSavedRoutes();
    updatePlayer();
  }
  function setSavedRoutes(list) {
    store.set("parcours", JSON.stringify(list));
    showSavedRoutes();
  }
  /** Parcours en cours et ses réglages : { name, date, travel (Requeteur travelForm state, points résolus), settings
   * (identifiant -> valeur ou case), places, zone, target, since, instance, producer : celui de la photo affichée, [id, nom]
   * ou null } (id : celui du parcours gardé à remplacer) ; null sans départ ou arrivée trouvés. */
  async function currentRoute(id = routeId()) {
    const found = await travelFields.go();
    if (!found) return null;
    const travel = travelFields.state();
    travel.start.point = found.start;
    travel.end.point = found.end;
    const key = $("#interet-cible").value, target = poiTargets.get(key);
    return {
      id, name: found.title, date: new Date().toISOString().slice(0, 10), travel,
      settings: Object.fromEntries(routeSettings().map((e) => [e.id, e.type === "checkbox" ? e.checked : e.value])),
      places: Object.fromEntries(Object.entries(placed).map(([k, kind]) => [k, kind.points.map(placeOf)])),
      zone: poi.zone,
      target: target ? { lonlat: target.lonlat, z: target.z,
        label: key === "parcours" ? poiKept.label : $("#interet-cible").selectedOptions[0]?.textContent || "Cible" } : null,
      since: $("#depuis").value || null,
      instance: instance.value,
      producer: app && photo ? JSON.parse(app.producer()) : null,
    };
  }
  /** Parcours lu d'un fichier (venu d'ailleurs) : seulement des textes courts, des nombres, des [lon, lat] et les
   * réglages connus ; null s'il n'en est pas un. */
  function cleanRoute(r) {
    if (!r || typeof r !== "object" || !r.travel || typeof r.travel !== "object") return null;
    const lonlat = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180
      && Math.abs(p[1]) <= 90;
    const text = (v, n) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, n) : "");
    const side = (s) => ({ pr: text(s?.pr, 10), distance: text(s?.distance, 10), point: lonlat(s?.point) ? s.point : null });
    const ids = new Set(routeSettings().map((e) => e.id));
    return {
      id: routeId(), name: text(r.name, 200) || "Parcours", date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "",
      travel: { route: text(r.travel.route, 20), start: side(r.travel.start), end: side(r.travel.end) },
      settings: Object.fromEntries(Object.entries(r.settings || {})
        .filter(([k, v]) => ids.has(k) && (typeof v === "boolean" || typeof v === "string"))
        .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 120) : v])),  // titre libre : 80 caractères
      places: Object.fromEntries(Object.keys(placed).map((k) => [k,
        (Array.isArray(r.places?.[k]) ? r.places[k] : []).filter((p) => lonlat(p) || (k === "planet" && Array.isArray(p)
          && p.length === 2 && p.every(lonlat))).slice(0, 50)])),
      zone: Array.isArray(r.zone) && r.zone.length === 2 && r.zone.every(lonlat) ? r.zone : null,
      target: lonlat(r.target?.lonlat) ? { lonlat: r.target.lonlat, z: Number.isFinite(r.target.z) ? r.target.z : null,
        label: text(r.target.label, 100).replace(/ \(parcours gardé\)$/, "") || "Cible" } : null,
      since: /^\d{4}-\d{2}-\d{2}$/.test(r.since) ? r.since : null,
      // Absents d'un parcours gardé avant le ticket #40 : à l'ouverture, ceux en cours ne changent pas
      ...(typeof r.instance === "string" ? { instance: text(r.instance, 200) } : {}),
      ...("producer" in r ? { producer: Array.isArray(r.producer) && r.producer.length === 2 && r.producer.every((v) => typeof v === "string")
        ? r.producer.map((v) => v.slice(0, 200)) : null } : {}),
    };
  }
  /** Parcours rouvert : plus aucune photo de son producteur à son départ ni à son arrivée (instance ou méta-catalogue
   * en cours) : filtre producteur retiré, le parcours se fait avec les photos qui restent. Réseau en échec : filtre gardé. */
  async function dropMissingProducer(r) {
    if (!r.producer) return;
    const fromProducer = (f) => (f.providers || f.properties?.providers || []).some((p) => p.id === r.producer[0] && p.roles?.includes("producer"));
    const near = await Promise.all([r.travel.start.point, r.travel.end.point].filter(Boolean)
      .map((p) => Carte.photosNear(map, ...p, fromProducer, TOUR_REACH))).catch(() => null);
    if (!near || near.some((found) => found.length) || openedRoute !== r.id || $("#producteur").value !== JSON.stringify(r.producer)) return;
    $("#producteur").value = "";
    applyFilter();
    markOpened(r.id);  // pas une modification du parcours : il garde son producteur
    notice(`Plus de photos de ${r.producer[1]} sur ce parcours : filtre producteur retiré.`);
  }
  /** Parcours gardé rouvert dans l'onglet « Vidéo » : départ, arrivée, réglages, endroits, zone, cible et filtre de date ;
   * vidéo à préparer. */
  function openRoute(r) {
    if (videoRun) return notice("Vidéo en cours de calcul : arrêtez-la avant d'ouvrir un parcours.");
    showPane("parcours");
    if ("instance" in r && r.instance !== instance.value) {
      if ([...instance.options].some((o) => o.value === r.instance)) {
        instance.value = r.instance;
        instance.dispatchEvent(new Event("change"));
      } else {  // fichier reçu : pas d'appel à un serveur que la liste des instances ne connaît pas
        notice(`Instance du parcours inconnue (${r.instance}) : l'instance choisie reste.`);
      }
    }
    if (r.producer) addProducer(r.producer);
    const producer = !("producer" in r) ? $("#producteur").value : r.producer ? JSON.stringify(r.producer) : "";
    if (($("#depuis").value || null) !== r.since || $("#producteur").value !== producer) {
      $("#depuis").value = r.since || "";
      $("#producteur").value = producer;
      applyFilter();
    }
    travelFields.restore(r.travel);
    for (const kind of Object.values(placed)) {
      for (const p of kind.points) p.marker.remove();
      kind.points = [];
    }
    planetDraft = null;
    // Petite planète : [début, fin] ; endroit seul (gardé avant le 01/11) : tronçon court centré sur lui (Video.planets)
    for (const [which, list] of Object.entries(r.places)) list.forEach((p) => placePoint(which, ...(Array.isArray(p[0]) ? p : [p])));
    poi.zone = r.zone;
    poi.draft = null;
    // Cible : objet du relevé au même endroit (moins de 0,5 m), sinon celle du parcours, proposée en plus du relevé
    const near = r.target && [...poiTargets].find(([key, t]) => key !== "parcours" && metresBetween(t.lonlat, r.target.lonlat) < 0.5);
    poiKept = r.target && !near ? r.target : null;
    refreshPoiTargets(poiJson);
    if (r.target) $("#interet-cible").value = near ? near[0] : "parcours";
    for (const e of routeSettings()) {
      if (!(e.id in r.settings)) continue;
      if (e.type === "checkbox") e.checked = r.settings[e.id] === true;
      else e.value = r.settings[e.id];
      if (e.type === "range") e.dispatchEvent(new Event("input"));  // valeur affichée à côté
    }
    keepFormat();
    videoPlan = null;
    showPoiZone();
    updateTravel();
    const [a, b] = [r.travel.start.point, r.travel.end.point];
    if (a && b) {
      map.fitBounds([[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]],
        { padding: 60, maxZoom: 17 });
    }
    markOpened(r.id);
    dropMissingProducer(r);
    setStatus(`Parcours « ${r.name} » rouvert : « 🎬 Préparer la vidéo » pour la calculer ; modifié, « ☆ Enregistrer les modifications » le remplace.`);
  }
  // Effets « communication » : pastille jaune sur le parcours gardé si l'un d'eux est activé, verte sinon
  // Modes de la vidéo : réglages de départ des options (avancées), appliqués au choix du mode et retouchables ensuite ;
  // la page s'ouvre en mode Présentation (cases cochées d'origine)
  const VIDEO_MODES = {
    brouillon: { help: "Vérifier vite le trajet : allure de la présentation, image 960 × 540, titre et compteur de vitesse.",
      on: ["video-brouillon", "video-compteur", "video-compteur-vitesse", "video-titre"],
      off: ["video-acceleration", "video-vmax-arp", "video-flou", "video-expo", "video-rampe"] },
    presentation: { help: "Vue rapide de l'itinéraire : vitesse selon les virages, compteurs PR et vitesse, sans option coûteuse en calcul.",
      on: ["video-compteur", "video-compteur-vitesse", "video-titre"],
      off: ["video-brouillon", "video-acceleration", "video-vmax-arp", "video-flou", "video-expo", "video-rampe"] },
    revue: { help: "Vitesse fixe : compteurs PR et vitesse, accélération latérale et V max ARP. Dévers lu sur le LiDAR HD, environ 1 min de plus.",
      on: ["video-compteur", "video-compteur-vitesse", "video-acceleration", "video-vmax-arp", "video-titre"],
      off: ["video-brouillon", "video-rampe"] },
  };
  const showModeHelp = () => {
    // Parcours gardé autrefois avec la case « Brouillon » : ce mode, quelle que soit la liste
    const name = $("#video-brouillon").checked ? "brouillon" : $("#video-mode").value;
    for (const button of travelPane.querySelectorAll(".modes-video button")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === name));
      button.disabled = Boolean(videoRun) || !videoPlan;
    }
    $("#video-mode-aide").textContent = `${VIDEO_MODES[name]?.help || ""}${modeTouched(name) ? " Réglages modifiés : cliquer sur le mode rétablit les siens." : ""}`;
  };
  /** Option de la vidéo active ? Brouillon : seuls le titre, le compteur de vitesse et les variations de vitesse automatiques
   * restent (DRAFT_OFF). */
  const videoOption = (id) => $(id).checked && !$("#video-brouillon").checked;
  const DRAFT_OFF = ["#video-compteur", "#video-acceleration", "#video-vmax-arp", "#video-stabilisation", "#video-flou", "#video-expo", "#video-regard", "#regard-vitesse",
    "#video-interet", "#interet-cible", "#interet-vitesse", "#interet-zoom", "#interet-zoom-distance", "#interet-tonneau", "#video-tonneau", "#tonneau-duree",
    "#video-tour", "#tour-duree", "#tour-arret", "#video-planete", "#planete-tout", "#planete-transition", "#planete-tonneau", "#planete-rotation", "#arret-duree", "#video-arret"];
  /** Réglages du mode Présentation pour Video (vitesses en m/s), ou null dans un autre mode. */
  function presOptions() {
    if ($("#video-mode").value === "revue") return null;
    return { vmax: Number($("#pres-vmax").value) / 3.6, vmin: Number($("#pres-vmin").value) / 3.6, turn: Number($("#pres-virage").value),
      fade: Number($("#pres-transition").value), stop: Number($("#arret-duree").value),
      stops: videoOption("#video-arret") ? placed.stop.points.map((p) => p.lonlat) : [],
      slows: $("#video-ralenti").checked ? placed.slow.points.map((p) => p.lonlat) : [], slow: Number($("#ralenti-vitesse").value) / 3.6 };
  }
  /** Carrefours du parcours préparé plan (tronçons de la BD TOPO, mailles en cache) et, avec structures, ses ouvrages d'art : lus une
   * fois, seulement pour les options qui s'en servent (croisements et ouvrages d'art, regard aux croisements). */
  async function readCrossings(plan, structures) {
    const coords = plan.photos.map((p) => p.coords);
    plan.junctions ??= await Lieu.junctions(coords).catch(() => []);
    if (structures) plan.structures ??= await Lieu.structures(coords).catch(() => []);
  }
  /** Points de ralentissement posés d'eux-mêmes : croisements de routes revêtues et ouvrages d'art de la vidéo préparée
   * à moins de 15 m de ses photos, un par 30 m (giratoire : un seul) ; retouchables (clic : retirer, 📍 : ajouter). */
  async function fillSlows() {
    if (!videoPlan) return setStatus("Croisements et ouvrages d'art : ils seront posés d'eux-mêmes une fois les photos trouvées.");
    const plan = videoPlan;
    setStatus("Vidéo : recherche des croisements et des ouvrages d'art…");
    await readCrossings(plan, true);
    if (plan !== videoPlan || !$("#video-ralenti").checked) return;  // parcours changé ou option décochée entre-temps
    const coords = videoPlan.photos.map((p) => p.coords).filter(Boolean), found = [];
    for (const { lonlat } of [...videoPlan.junctions || [], ...videoPlan.structures || []]) {
      if (coords.some((c) => metresBetween(c, lonlat) < 15) && !found.some((f) => metresBetween(f, lonlat) < 30)) found.push(lonlat);
    }
    for (const lonlat of found) placePoint("slow", lonlat);
    setStatus(`${found.length} point${found.length > 1 ? "s" : ""} de ralentissement posé${found.length > 1 ? "s" : ""} `
      + "(repères orange) : clic sur un repère pour le retirer, 📍 pour en ajouter.");
  }
  // Réglettes du mode Présentation : valeur affichée à côté ; elles changent la durée de la vidéo
  for (const [id, unit] of [["pres-vmax", "km/h"], ["pres-virage", "°/s"], ["pres-vmin", "km/h"], ["pres-transition", "s"], ["arret-duree", "s"], ["ralenti-vitesse", "km/h"]]) {
    $(`#${id}`).addEventListener("input", () => {
      $(`#${id.replace("-duree", "")}-valeur`).textContent = `${String($(`#${id}`).value).replace(".", ",")} ${unit}`;
      updatePlayer();
    });
  }
  /** Options autres que celles du mode name ? */
  function modeTouched(name) {
    const mode = VIDEO_MODES[name];
    return Boolean(mode) && routeSettings().some((e) => {
      if (e.id === "video-mode" || e.type === "text") return false;
      if (e.type === "checkbox") return e.checked !== (mode.on.includes(e.id) || (!mode.off.includes(e.id) && e.defaultChecked));
      if (e.tagName === "SELECT") return e.selectedOptions[0] !== ([...e.options].find((o) => o.defaultSelected) || e.options[0]);
      return e.value !== e.defaultValue;
    });
  }
  // Choix du mode : ses réglages, ceux des autres options remis à leur valeur de la page (les textes du titre et les endroits restent)
  for (const button of travelPane.querySelectorAll(".modes-video button")) {
    button.addEventListener("click", () => {
      for (const e of routeSettings()) {
        if (e.id === "video-mode" || e.type === "text") continue;
        resetSetting(e);
        if (e.type === "range") e.dispatchEvent(new Event("input"));  // valeur affichée à côté
      }
      $("#video-mode").value = button.dataset.mode;
      $("#video-mode").dispatchEvent(new Event("change"));
    });
  }
  $("#video-mode").addEventListener("change", () => {
    const mode = VIDEO_MODES[$("#video-mode").value];
    for (const id of mode.on) $(`#${id}`).checked = true;
    for (const id of mode.off) $(`#${id}`).checked = false;
    showModeHelp();
    updatePlayer();
  });
  showModeHelp();
  $("#video-titre").addEventListener("change", updatePlayer);
  $("#video-brouillon").addEventListener("change", updatePlayer);
  const ROUTE_EFFECTS = [["video-tonneau", "tonneau"], ["video-planete", "petite planète"], ["video-interet", "point d'intérêt"],
    ["video-regard", "regard aux croisements"], ["video-tour", "tour d'horizon"]];
  /** Réglage remis à sa valeur de la page (case, liste, réglette). */
  function resetSetting(e) {
    if (e.type === "checkbox") e.checked = e.defaultChecked;
    else if (e.tagName === "SELECT") e.value = ([...e.options].find((o) => o.defaultSelected) || e.options[0]).value;
    else e.value = e.defaultValue;
  }
  /** Parcours et réglages déjà à zéro (« ↺ RAZ » sans effet) ? */
  function routeIsBlank() {
    const t = travelFields.state();
    return !t.route && [t.start, t.end].every((s) => !s.pr && !s.point && !Number(s.distance))
      && Object.values(placed).every((kind) => !kind.points.length) && !poi.zone && !poi.draft && !planetDraft && !poiKept
      && routeSettings().every((e) => (e.type === "checkbox" ? e.checked === e.defaultChecked
        : e.tagName === "SELECT" ? e.selectedOptions[0]?.defaultSelected || (!e.selectedIndex && ![...e.options].some((o) => o.defaultSelected))
          : e.value === e.defaultValue));
  }
  // Remise à zéro du parcours et de ses réglages (le filtre des photos et les parcours gardés ne changent pas)
  $("#parcours-raz").addEventListener("click", () => {
    if (videoRun) return;
    setTravelPick(null);
    travelFields.restore({ route: "", start: {}, end: {} });
    for (const kind of Object.values(placed)) {
      for (const p of kind.points) p.marker.remove();
      kind.points = [];
    }
    poi.zone = null;
    poi.draft = null;
    planetDraft = null;
    showPlanets();
    poiKept = null;
    refreshPoiTargets(poiJson);
    for (const e of routeSettings()) {
      resetSetting(e);
      if (e.type === "range") e.dispatchEvent(new Event("input"));  // valeur affichée à côté
    }
    videoPlan = null;
    showPoiZone();
    updateTravel();
    markOpened(null);
    setStatus("Parcours et réglages remis à zéro.");
  });
  const routeFile = (list) => JSON.stringify({ format: "parcours-panoramax", parcours: list }, null, 1);
  function showSavedRoutes() {
    const list = savedRoutes();
    $("#mes-parcours ol").replaceChildren(...list.map((r, k) => {
      const li = Object.assign(document.createElement("li"), { className: r.id === openedRoute ? "actuelle" : "" });
      const effects = ROUTE_EFFECTS.filter(([id]) => r.settings?.[id] === true).map(([, name]) => name);
      const dot = Object.assign(document.createElement("span"), { className: `pastille ${effects.length ? "communication" : "sobre"}`,
        title: effects.length ? `Effets de communication : ${effects.join(", ")}` : "Sans effet de communication" });
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", dot.title);
      const go = Object.assign(document.createElement("button"), { type: "button", className: "aller-favori",
        title: "Rouvrir ce parcours et ses réglages dans l'onglet Vidéo" });
      go.append(r.name, ...(r.date ? [Object.assign(document.createElement("span"), { className: "aide",
        textContent: ` · ${r.date.split("-").reverse().join("/")}` })] : []));
      go.addEventListener("click", () => openRoute(r));
      const share = Object.assign(document.createElement("button"), { type: "button", className: "effacer-resultat",
        textContent: "⤓", title: "Exporter ce parcours seul (fichier à envoyer, à importer dans l'onglet Parcours)" });
      share.setAttribute("aria-label", `Exporter le parcours : ${r.name}`);
      share.addEventListener("click", () => download(routeFile([r]), `parcours ${r.name.replace(/[\\/:*?"<>|]/g, "-")}.json`,
        "application/json"));
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "effacer-resultat",
        textContent: "×", title: "Retirer ce parcours" });
      remove.setAttribute("aria-label", `Retirer le parcours : ${r.name}`);
      remove.addEventListener("click", () => {
        if (r.id === openedRoute) openedRoute = null;  // plus rien à mettre à jour
        setSavedRoutes(savedRoutes().filter((_, i) => i !== k));
        updatePlayer();
      });
      li.append(dot, go, share, remove);
      return li;
    }));
    const n = list.length;
    $("#mes-parcours-exporter").disabled = !n;
    $("#compte-mes-parcours").textContent = n || "";
    $("#mes-parcours-infos").textContent = n ? `${n} parcours · gardé${n > 1 ? "s" : ""} dans ce navigateur` : "Aucun parcours";
  }
  // Parcours gardé rouvert et modifié : enregistré dans celui-ci ou en nouveau parcours, au choix
  $("#parcours-garder").addEventListener("click", () => {
    if (!routeChanged()) return keepRoute(routeId());
    const dialog = $("#enregistrer-parcours");
    dialog.querySelector("p span").textContent = savedRoutes().find((r) => r.id === openedRoute)?.name || "";
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue) keepRoute(dialog.returnValue === "remplacer" ? openedRoute : routeId());
    }, { once: true });
    dialog.showModal();
  });
  /** Parcours en cours gardé sous l'identifiant id : remplace le parcours gardé de même identifiant, sinon ajouté. */
  async function keepRoute(id) {
    const route = await currentRoute(id).catch(() => null);
    if (!route) return notice("Parcours : départ ou arrivée introuvable, rien de gardé.");
    const list = savedRoutes(), k = list.findIndex((r) => r.id === route.id);
    if (k >= 0) list[k] = route; else list.push(route);
    setSavedRoutes(list);
    markOpened(route.id);
    setStatus(k >= 0 ? `Parcours « ${route.name} » mis à jour avec ses réglages (onglet Parcours).`
      : `Parcours « ${route.name} » gardé avec ses réglages (onglet Parcours).`);
  }
  $("#mes-parcours-exporter").addEventListener("click", () => download(routeFile(savedRoutes()), "parcours-panoramax.json",
    "application/json"));
  $("#mes-parcours-importer").addEventListener("click", () => $("#mes-parcours-fichier").click());
  $("#mes-parcours-fichier").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    let read;
    try { read = JSON.parse(await file.text()); } catch { read = null; }
    const list = (Array.isArray(read) ? read : Array.isArray(read?.parcours) ? read.parcours : [read]).map(cleanRoute).filter(Boolean);
    if (!list.length) return notice("Fichier de parcours illisible.");
    setSavedRoutes([...savedRoutes(), ...list]);
    notice(`${list.length} parcours importé${list.length > 1 ? "s" : ""}.`);
  });
  showSavedRoutes();
  /** Altitudes du sol (LiDAR HD, sinon RGE ALTI ; null si inconnue) aux points [lon, lat], par lots de 150. */
  async function groundAltitudes(points, fallback = true, progress = () => {}) {
    const out = [];
    for (let i = 0; i < points.length; i += 150) {
      progress(i, points.length);
      const part = points.slice(i, i + 150);
      const ask = async (resource) => {
        const url = `${Carte.GEOPF}/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${part.map((p) => p[0].toFixed(6)).join("|")}`
          + `&lat=${part.map((p) => p[1].toFixed(6)).join("|")}&resource=${resource}&zonly=true`;
        // Calcul altimétrique de la Géoplateforme : 5 requêtes/s par adresse IP au plus, puis HTTP 429 et blocage de 5 s
        // (geoservices.ign.fr, « Limite d'usage ») : une requête tous les ALTI_GAP ms au plus ; refus ou serveur
        // occupé : attente de la fin du blocage, jusqu'à ALTI_TRIES essais
        for (let attempt = 1; ; attempt++) {
          const wait = altiNext - Date.now();
          altiNext = Math.max(Date.now(), altiNext) + ALTI_GAP;
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          const response = await fetch(url);
          if (response.ok) return (await response.json()).elevations || [];
          if (attempt === ALTI_TRIES || (response.status !== 429 && response.status < 500)) throw new Error(`HTTP ${response.status}`);
          altiNext = Date.now() + ALTI_BLOCK;
        }
      };
      const warn = (error) => {
        console.warn("Altitudes du sol non lues", error);
        return [];
      };
      const lidar = await ask("ign_lidar_hd_mnt_mono_wld").catch(warn);
      const missing = part.some((_, k) => !(lidar[k] > -1000));
      const alti = missing && fallback ? await ask("ign_rge_alti_wld").catch(warn) : [];
      part.forEach((_, k) => out.push(lidar[k] > -1000 ? lidar[k] : alti[k] > -1000 ? alti[k] : null));
    }
    progress(points.length, points.length);
    return out;
  }
  // Une requête d'altitudes tous les ALTI_GAP ms (2,5/s, la moitié de la limite : place pour les autres calculs du sol),
  // ALTI_BLOCK ms d'attente après un refus, ALTI_TRIES essais (une minute environ)
  const ALTI_GAP = 400, ALTI_BLOCK = 5500, ALTI_TRIES = 12;
  let altiNext = 0;  // heure de la prochaine requête permise
  // Dévers sous chaque photo du parcours préparé, pour classer l'accélération latérale selon l'ARP :
  // pente en travers du MNT LiDAR HD seul (le RGE ALTI est trop grossier pour un dévers), plan ajusté sur une grille de
  // DEVERS_ACROSS × DEVERS_ALONG m autour de la caméra (la voie du véhicule). shortcut: sur un pont, le LiDAR donne le
  // terrain sous le tablier ; écarter ces photos (Lieu, ponts BD TOPO) si des viaducs en virage comptent.
  const DEVERS_ACROSS = [-1.5, -0.75, 0, 0.75, 1.5], DEVERS_ALONG = [-1.5, 0, 1.5];
  // Aide des deux options qui classent selon l'ARP : dit si le dévers a été lu (couleurs, vitesse conformes)
  const arpOptions = ["#video-acceleration", "#video-vmax-arp"].map((id) => ({ box: $(id),
    help: $(id).closest("label").querySelector(".aide") })).map((o) => ({ ...o, text: o.help.textContent }));
  const arpWanted = () => arpOptions.some((o) => o.box.checked);
  const arpHelp = (text) => arpOptions.forEach((o) => { o.help.textContent = o.box.checked && text ? text : o.text; });
  async function readDevers() {
    const plan = videoPlan;
    if (!plan || !arpWanted()) {
      arpHelp(null);
      return;
    }
    plan.devers ??= (async () => {
      arpHelp("Dévers lu sur le LiDAR HD…");
      const path = Video.trajectory(plan.photos), toRad = Math.PI / 180, points = [];
      path.list.forEach((p, i) => {
        const b = path.course(path.s[i]) * toRad, k = 111320 * Math.cos(p.coords[1] * toRad);
        for (const a of DEVERS_ALONG) {
          for (const c of DEVERS_ACROSS) {
            const east = Math.sin(b) * a + Math.cos(b) * c, north = Math.cos(b) * a - Math.sin(b) * c;
            points.push([p.coords[0] + east / k, p.coords[1] + north / 111320]);
          }
        }
      });
      const z = await groundAltitudes(points, false, (done, all) => {
        arpHelp(`Dévers lu sur le LiDAR HD (lent) : ${Math.round(100 * done / all)} %…`);
        if (videoPreparing) setStatus(`Vidéo : dévers des photos (LiDAR HD, lent) : ${Math.round(100 * done / all)} %…`);
      }).catch(() => []), n = DEVERS_ACROSS.length * DEVERS_ALONG.length;
      const sum2 = DEVERS_ALONG.length * DEVERS_ACROSS.reduce((t, c) => t + c * c, 0);
      let read = 0;
      path.list.forEach((p, i) => {
        const part = z.slice(i * n, i * n + n);
        p.devers = part.length === n && part.every((h) => h != null)
          ? -part.reduce((t, h, j) => t + DEVERS_ACROSS[j % DEVERS_ACROSS.length] * h, 0) / sum2 : null;
        if (p.devers != null) read++;
      });
      return { read, total: path.list.length };
    })();
    const { read, total } = await plan.devers;
    if (videoPlan !== plan || !arpWanted()) return;
    arpHelp(read === total
      ? "Conforme au classement de l'ARP (dévers lu sur le LiDAR HD)."
      : read
        ? `Dévers lu sur le LiDAR HD pour ${read} photos sur ${total} : conforme à l'ARP là seulement, `
          + "ailleurs approché (dévers compté nul)."
        : "Dévers non lu (LiDAR HD absent ou sans réponse) : approché (dévers compté nul), non conforme à l'ARP.");
  }
  for (const { box } of arpOptions) box.addEventListener("change", readDevers);

  // Photos du parcours cherchées d'elles-mêmes dès que départ et arrivée sont connus (planPhotos), de nouveau s'ils changent ;
  // une réponse pour un parcours changé entre-temps est jetée
  const planKey = () => JSON.stringify([travelFields.state(), placed.waypoint.points.map(placeOf), $("#depuis").value, instance.value, $("#producteur").value]);
  function scheduleVideoPlan() {
    if (videoPlan || !videoReady || !videoOk || videoPreparing || videoRun || planTimer) return;
    const key = planKey();
    if (planError?.key === key) return;
    planTimerKey = key;
    planTimer = setTimeout(() => {
      planTimer = null;
      if (planKey() === planTimerKey) prepareVideo();
      else updatePlayer();  // encore en train de changer
    }, VIDEO_PLAN_DELAY);
  }
  async function prepareVideo() {
    if (videoPlan || !videoReady || videoPreparing || videoRun) return;
    const key = planKey();
    videoPreparing = true;
    planError = null;
    updatePlayer();
    setStatus("Vidéo : recherche des photos du parcours…");
    try {
      const found = await travelFields.go();
      if (!found) throw new Error("départ ou arrivée introuvable");
      if (metresBetween(found.start, found.end) < TOUR_REACH) {
        throw new Error(`départ et arrivée au même endroit (moins de ${TOUR_REACH} m) : choisissez l'arrivée (📍 de l'arrivée, ou son PR)`);
      }
      const plan = { ...await planLegs(found.start, found.end), title: found.title };
      setStatus("Vidéo : PR des photos…");
      await prOfPhotos(plan.photos, found.title.split(" ")[0]);
      if ($("#video-regard").checked) await readCrossings(plan, false);
      if (planKey() !== key) return;  // parcours changé : recherche relancée (updatePlayer, ci-dessous)
      videoPlan = plan;
      const coords = plan.photos.map((p) => p.coords).filter(Boolean);
      for (const p of [...placed.slow.points]) {  // parcours changé : ceux de l'ancien tracé retirés
        if (!coords.some((c) => metresBetween(c, p.lonlat) < 30)) {
          p.marker.remove();
          placed.slow.points = placed.slow.points.filter((q) => q !== p);
        }
      }
      // Croisements et ouvrages posés d'eux-mêmes si l'option est cochée et qu'aucun n'est encore posé (ceux d'un parcours gardé,
      // retouchés, restent)
      if ($("#video-ralenti").checked && !placed.slow.points.length) await fillSlows();
      setStatus(videoPlan.switches ? `Vidéo prête à enregistrer. ${videoWarning()}` : "Vidéo prête à enregistrer.",
        videoPlan.switches ? "avertissement" : "");
    } catch (error) {
      if (planKey() === key) {
        planError = { key, text: error.message };
        setStatus(`Vidéo impossible : ${error.message}`, "echec");
      }
    } finally {
      videoPreparing = false;
      updatePlayer();
    }
  }
  /** Raccords du parcours : { at (position), pr, before, after (dates des séquences) }. */
  function videoSeams(photos) {
    const dateOf = (p) => (p.date ? p.date.split("-").reverse().join("/") : "date inconnue");
    return photos.slice(1).flatMap((p, k) => (p.collection === photos[k].collection ? []
      : [{ at: p.coords, pr: p.pr, before: dateOf(photos[k]), after: dateOf(p) }]));
  }
  /** Bandeau du parcours : recherche, échec, séquence unique ou raccords à voir sur la carte (repères) ; refait seulement s'il change. */
  function showVideoPlan() {
    const box = $("#video-bandeau"), plan = videoPlan;
    const failed = planError && videoReady && planError.key === planKey() ? planError.text : null;
    const searching = !plan && videoReady && !failed;
    const key = JSON.stringify([videoReady, searching, failed, plan && plan.photos.length, plan?.title, plan && plan.photos[0]?.id, plan?.switches]);
    if (key === bandeauKey) return;
    bandeauKey = key;
    for (const marker of seamMarkers) marker.remove();
    seamMarkers = [];
    box.hidden = !videoReady;
    box.className = "bandeau-video";
    const strong = (text) => Object.assign(document.createElement("strong"), { textContent: text });
    if (searching) {
      box.replaceChildren(strong("Recherche des photos le long du tracé…"),
        Object.assign(document.createElement("progress"), { id: "video-recherche", max: 1, ariaLabel: "Avancement de la recherche des photos" }),
        Object.assign(document.createElement("p"), { className: "aide", textContent: "Relancée si le tracé change." }));
    } else if (failed) {
      box.classList.add("alerte");
      box.replaceChildren(strong("Vidéo impossible"), failed);
    } else if (plan && plan.photos.length < 2) {
      box.classList.add("alerte");
      box.replaceChildren(strong("Vidéo impossible"), "moins de deux photos sur ce parcours");
    } else if (plan) {
      const seams = videoSeams(plan.photos), sequences = new Set(plan.photos.map((p) => p.collection)).size;
      const km = (Video.trajectory(plan.photos).length / 1000).toFixed(1).replace(".", ",");
      const dates = [...new Set(plan.dates)].map((d) => d.split("-").reverse().join("/")).join(", ");
      const facts = `${km} km · ${plan.photos.length} photos${dates ? ` · ${dates}` : ""}`;
      if (!seams.length) {
        box.classList.add("ok");
        box.replaceChildren(strong("Une seule séquence"), facts);
      } else {
        box.classList.add("alerte");
        const list = document.createElement("ul");
        for (const seam of seams) {
          const see = Object.assign(document.createElement("button"), { type: "button", textContent: "Voir", title: "Centrer la carte sur ce changement de séquence" });
          see.addEventListener("click", () => map.easeTo({ center: seam.at, zoom: Math.max(map.getZoom(), 15) }));
          const where = seam.pr ? `PR ${seam.pr.n} ${seam.pr.m < 0 ? "-" : "+"} ${Math.abs(seam.pr.m)}` : "Hors PR";
          const li = document.createElement("li");
          li.append(see, ` ${where} : ${seam.before} puis ${seam.after}`);
          list.append(li);
          seamMarkers.push(new maplibregl.Marker({ element: Object.assign(document.createElement("div"), { className: "repere-requete raccord", title: `Changement de séquence : ${seam.before} puis ${seam.after}` }), anchor: "bottom" }).setLngLat(seam.at).addTo(map));
        }
        box.replaceChildren(strong(`${sequences} séquences : ${seams.length} changement${seams.length > 1 ? "s" : ""}`), facts, list,
          Object.assign(document.createElement("p"), { className: "aide", textContent: "Les photos peuvent différer (date, lumière, sens de prise de vue)." }));
      }
    }
  }
  /** Durée de la vidéo préparée, en secondes. */
  const videoSeconds = () => {
    const v = presOptions()?.vmax ?? Number($("#video-vitesse").value) / 3.6;  // Présentation : celle des lignes droites
    return Video.duration(videoPhotos(), v * 3.6, $("#video-rampe").checked,
      videoOption("#video-regard") ? videoPlan.junctions || [] : [], Number($("#regard-vitesse").value), poiOptions(), presOptions()) + tourStops();
  };
  const secondsText = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);

  // Vidéo MP4 du parcours préparé : « Enregistrer » demande le fichier (la boîte ne s'ouvre que juste après un clic), puis
  // calcule la vidéo image par image
  $("#parcours-video").addEventListener("click", async () => {
    if (!videoPlan) return;
    const save = await saveAs(`parcours ${videoPlan.title || "Panoramax"} ${$("#video-vitesse").value} km-h.mp4`
      .replace(/[\\/:*?"<>|→]/g, "-"), "video/mp4");
    if (!save) return;
    videoRun = new AbortController();
    updatePlayer();
    const t0 = Date.now();
    let watch = null, stalled = false, stream = null;
    try {
      // Point d'intérêt : altitudes du sol sous les photos (caméra) et sous la cible si l'objet n'a pas d'altitude (visée
      // en hauteur ; inconnues : à l'horizontale)
      let poiAim = poiOptions();
      if (poiAim) {
        setStatus("Vidéo : altitudes pour viser le point d'intérêt…");
        const photos = videoPhotos();
        const alts = await groundAltitudes([poiAim.target, ...photos.map((p) => p.coords)]).catch(() => []);
        poiAim = { ...poiAim, ground: { target: alts[0] ?? null, photos: photos.map((_, k) => alts[k + 1] ?? null) } };
      }
      if (arpWanted()) await readDevers();
      if (videoOption("#video-regard")) await readCrossings(videoPlan, false);
      // Serveur d'images bloqué (Video réessaie) : avertissement au bout de VIDEO_STALL s sans image calculée, Attendre
      // ou Annuler ; fenêtre refermée dès que le calcul reprend ; arrêt au bout de VIDEO_GIVE_UP s
      let last = Date.now(), warned = false;
      watch = setInterval(() => {
        const idle = (Date.now() - last) / 1000;
        if (idle >= VIDEO_GIVE_UP) {
          stalled = true;
          videoRun?.abort();
        } else if (idle >= VIDEO_STALL && !warned) {
          warned = true;
          ask($("#video-attente"), `Le serveur d'images ne répond plus depuis ${VIDEO_STALL} s ; nouveaux essais en cours. `
            + `Sans réponse, le calcul s'arrêtera de lui-même au bout de ${VIDEO_GIVE_UP / 60} min.`)
            .then((choice) => { if (choice === "annuler") videoRun?.abort(); });
        }
      }, 1000);
      // Avancement aussi dans la ligne d'état : calcul de plusieurs minutes
      // Fichier choisi (Chrome, Edge) : vidéo écrite au fur et à mesure, mémoire constante quelle que soit la longueur ;
      // sinon (Firefox) assemblée en mémoire puis téléchargée
      if (save.handle) stream = await save.handle.createWritable();
      Video.ignoredPlaces();  // liste remise à zéro (aperçus et durées déjà calculés)
      const blob = await Video.mp4(videoPhotos(), Number($("#video-vitesse").value), (done, total, step) => {
        last = Date.now();
        if (warned) {
          warned = false;
          if ($("#video-attente").open) $("#video-attente").close();
        }
        // Largeur fixe (chiffres de même largeur, espaces de la largeur d'un chiffre) : le texte ne saute pas
        const pad = (n, width) => String(n).padStart(width, "\u2007");
        const width = Math.max(5, String(total).length);  // place pour une longue vidéo (99 999 images, 55 min)
        // step : préparation avant la première image (Stabilisation, Exposition)
        const text = step ? `${step} avant le calcul de la vidéo : ${pad(Math.round(100 * done / total), 3)} %`
          : `Calcul de la vidéo en cours : image ${pad(done, width)} / ${pad(total, width)} (${pad(Math.round(100 * done / total), 3)} %)`;
        $("#video-info").textContent = text;
        $("#video-barre").value = done / total;
        setStatus(text, "avancement");
        $("#statut").style.setProperty("--avancement", `${(100 * done / total).toFixed(1)}%`);
      }, videoRun.signal, { blur: videoOption("#video-flou"), draft: $("#video-brouillon").checked, stabilize: videoOption("#video-stabilisation"), format: $("#video-codec").value, height: Number($("#video-definition").value), exposure: videoOption("#video-expo"),
        ramp: !presOptions() && $("#video-rampe").checked, presentation: presOptions(),
        counter: videoOption("#video-compteur"), speedometer: $("#video-compteur-vitesse").checked, lateral: videoOption("#video-acceleration"), arpSpeed: videoOption("#video-vmax-arp"),
        junctions: videoOption("#video-regard") ? videoPlan.junctions || [] : [],
        rolls: videoOption("#video-tonneau") ? placed.roll.points.map((p) => p.lonlat) : [], rollTime: Number($("#tonneau-duree").value),
        planets: videoOption("#video-planete") ? placed.planet.points.map(placeOf) : [],
        planetAll: videoOption("#video-planete") && $("#planete-tout").checked, planetRoll: $("#planete-tonneau").checked,
        planetFade: Number($("#planete-transition").value), planetSpin: Number($("#planete-rotation").value),
        tours: videoOption("#video-tour") ? placed.tour.points.map((p) => p.lonlat) : [],
        tourTime: Number($("#tour-duree").value), tourStop: $("#tour-arret").checked,
        poi: poiAim,
        lookSpeed: Number($("#regard-vitesse").value),
        title: $("#video-titre").checked ? { text: $("#video-titre-texte").value.trim() || videoPlan.title.replace(/\+0*(\d)/g, "+$1"),
          sub: $("#video-titre-sous").value.trim()
            || `Photos du ${videoPlan.dates.map((d) => d.split("-").reverse().join("/")).join(", du ") || "?"}`,
          keep: $("#video-titre-rappel").checked } : null,
        stream });
      if (!stream) await save(blob);
      const size = stream ? (await save.handle.getFile()).size : blob.size;
      const away = Video.ignoredPlaces();  // repères d'effets à plus de 30 m du parcours : ignorés, signalés
      const made = Video.times, format = { avc: "H.264", hevc: "H.265", vp9: "VP9" }[made.codec];
      const text = `Vidéo enregistrée dans « ${save.fileName} » : ${made.width} × ${made.height}, ${format}, ${(size / 1e6).toFixed(1)} Mo, `
        + `${Math.round((Date.now() - t0) / 1000)} s de calcul.`
        + (!$("#video-brouillon").checked && format !== FORMAT_NAMES[$("#video-codec").value] ? ` ${FORMAT_NAMES[$("#video-codec").value]} refusé par l'encodeur du poste.` : "")
        + (away.length ? ` Repères ignorés, à plus de 30 m du parcours : ${away.join(", ")}.` : "");
      setStatus(text);
      notice(text);
    } catch (error) {
      stream?.abort().catch(() => {});  // fichier entamé : rien d'écrit
      if (stalled) error = new Error(`serveur d'images sans réponse depuis ${VIDEO_GIVE_UP / 60} min, rien d'enregistré`);
      setStatus(error.name === "AbortError" ? "Vidéo arrêtée : rien d'enregistré." : `Vidéo impossible : ${error.message}`,
        error.name === "AbortError" ? "" : "echec");
      if (error.name !== "AbortError") notice(`Vidéo impossible : ${error.message}`);
    } finally {
      clearInterval(watch);
      if ($("#video-attente").open) $("#video-attente").close();
      videoRun = null;
      updatePlayer();
    }
  });
  $("#parcours-video-arret").addEventListener("click", () => videoRun?.abort());
  for (const id of ["#video-vitesse", "#video-photos", "#video-rampe", "#video-regard"]) $(id).addEventListener("change", updatePlayer);
  $("#video-regard").addEventListener("change", async () => {  // carrefours lus en cochant : durée et aperçu les suivent
    if (!$("#video-regard").checked || !videoPlan) return;
    await readCrossings(videoPlan, false);
    updatePlayer();
  });

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

  // Tours d'horizon avec arrêt : leur durée s'ajoute à celle de la vidéo
  /** Chronologie de la vidéo préparée, sans image, pour l'aperçu sur la carte : { path, xs } (positions des images, comme
   * Video.mp4 : allure ou rampe, regards aux croisements, point d'intérêt, tours d'horizon), ou null. */
  function videoFrames() {
    if (!videoPlan || videoPlan.photos.length < 2) return null;
    const path = Video.trajectory(videoPhotos()), pres = presOptions(), poi = poiOptions();
    let poiSlow = null;
    try {
      if (poi?.speed) poiSlow = { ...Video.poiSpan(path, poi), speed: poi.speed / 3.6 };
    } catch { /* zone loin du parcours : signalée au calcul de la vidéo */ }
    const looks = Video.lookedJunctions(path, videoOption("#video-regard") ? videoPlan.junctions || [] : []);
    const go = (p) => Video.timeline(path, Number($("#video-vitesse").value) / 3.6, !pres && $("#video-rampe").checked, looks,
      Number($("#regard-vitesse").value) / 3.6, poiSlow, p);
    let xs;
    try {
      xs = go(pres);
    } catch {
      xs = go(pres && { ...pres, stops: [], slows: [] });  // arrêt ou ralentissement loin du parcours
    }
    if (videoOption("#video-tour")) {
      try {
        xs = Video.tours(path, xs, placed.tour.points.map((p) => p.lonlat), Number($("#tour-duree").value), $("#tour-arret").checked).xs;
      } catch { /* endroit loin du parcours */ }
    }
    return { path, xs };
  }
  // Vitesse d'une image (km/h), moyennée sur ± 5 images (pas de battement d'une image à l'autre)
  const frameKmh = (xs, n) => 3.6 * Video.FPS * (xs[Math.min(xs.length - 1, n + 5)] - xs[Math.max(0, n - 5)])
    / (Math.min(xs.length - 1, n + 5) - Math.max(0, n - 5) || 1);
  // Tracé coloré selon la vitesse (tronçons de 10 m) sur la mini-carte, recalculé un peu après chaque changement de réglage
  const ALLURE_ID = "allure-video";
  let allureTimer = null;
  function showAllure() {
    if (!map.isStyleLoaded()) {
      map.once("idle", showAllure);
      return;
    }
    const frames = videoFrames(), features = [];
    if (frames) {
      const { path, xs } = frames;
      for (let n = 0, start = 0; n < xs.length; n++) {
        if (xs[n] - xs[start] < 10 && n < xs.length - 1) continue;
        if (xs[n] > xs[start]) {
          const line = [];
          for (let x = xs[start]; x < xs[n]; x += 2) line.push(path.at(x));
          line.push(path.at(xs[n]));
          features.push({ type: "Feature", properties: { kmh: 3.6 * Video.FPS * (xs[n] - xs[start]) / (n - start) },
            geometry: { type: "LineString", coordinates: line } });
        }
        start = n;
      }
    }
    const data = { type: "FeatureCollection", features };
    if (map.getSource(ALLURE_ID)) map.getSource(ALLURE_ID).setData(data);
    else if (features.length) {
      map.addSource(ALLURE_ID, { type: "geojson", data });
      map.addLayer({ id: ALLURE_ID, type: "line", source: ALLURE_ID, layout: { "line-cap": "round" }, paint: { "line-width": 5,
        "line-color": ["interpolate", ["linear"], ["get", "kmh"], 20, "#1e88e5", 60, "#43a047", 100, "#fdd835", 150, "#e53935"] } });
    }
  }
  // Aperçu en cours : { marker, label, raf } ; le repère parcourt le tracé en temps réel (une image de la vidéo par 1/30 s)
  let preview = null;
  function stopPreview() {
    if (!preview) return;
    cancelAnimationFrame(preview.raf);
    preview.marker.remove();
    preview = null;
    updatePlayer();
  }
  $("#parcours-apercu").addEventListener("click", () => {
    if (preview) return stopPreview();
    const frames = videoFrames();
    if (!frames) return;
    const { path, xs } = frames;
    const element = Object.assign(document.createElement("div"), { className: "apercu-video" });
    const label = element.appendChild(document.createElement("span"));
    const marker = new maplibregl.Marker({ element, anchor: "left", offset: [-8, 0] }).setLngLat(path.at(0)).addTo(map);
    const t0 = performance.now();
    preview = { marker };
    const step = () => {
      const n = Math.floor((performance.now() - t0) / 1000 * Video.FPS);
      if (n >= xs.length || !videoPlan) return stopPreview();
      const at = path.at(xs[n]);
      marker.setLngLat(at);
      label.textContent = `${Math.round(frameKmh(xs, n))} km/h · ${Math.floor(n / Video.FPS / 60)} min ${String(Math.floor(n / Video.FPS) % 60).padStart(2, "0")} s`;
      if (!map.getBounds().contains(at)) map.panTo(at);
      preview.raf = requestAnimationFrame(step);
    };
    step();
    updatePlayer();
  });
  const tourStops = () => (videoOption("#video-tour") && $("#tour-arret").checked
    ? placed.tour.points.length * Number($("#tour-duree").value) : 0);
  /** Parcours préparé : photos retenues, écart moyen, durée de la vidéo et photos par seconde (au-delà d'une par
   * image, 30/s, des photos sont sautées), changement de séquence. */
  function videoInfo(seconds) {
    if (!videoPlan) return "";
    if (videoPlan.photos.length < 2) return "moins de deux photos sur ce parcours";
    const v = presOptions()?.vmax ?? Number($("#video-vitesse").value) / 3.6;  // Présentation : celle des lignes droites
    const path = Video.trajectory(videoPhotos());
    const n = path.list.length, perSecond = v * (n - 1) / Math.max(1, path.length);
    return `${n} photos (une tous les ${(path.length / Math.max(1, n - 1)).toFixed(0)} m) · `
      + `${Math.round(seconds)} s · `
      + `${perSecond.toFixed(perSecond < 10 ? 1 : 0)} photos/s${$("#video-rampe").checked || presOptions() ? " au plus" : ""}`
      + (perSecond > Video.FPS ? " (photos sautées)" : "")
      + (videoPlan.reversed ? ` · ${videoPlan.reversed} photos lues à rebours (prises dans l'autre sens, pas d'autres ici)` : "");
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
    const plan = videoPlan?.photos || [];
    $("#parcours-video").disabled = !videoOk || !videoReady || videoPreparing || Boolean(videoRun)
      || Boolean(videoPlan && plan.length < 2);
    const seconds = plan.length >= 2 && !videoRun ? videoSeconds() : 0;
    $("#parcours-video").textContent = plan.length >= 2 ? `🎬 Enregistrer la vidéo · ${secondsText(seconds)}`
      : videoPlan ? "🎬 Pas assez de photos" : planError ? "🎬 Vidéo impossible" : videoReady ? "🎬 Recherche des photos…" : "🎬 Tracez le parcours";
    $("#parcours-video").hidden = Boolean(videoRun);
    $("#parcours-video-arret").hidden = !videoRun;
    $("#video-barre").hidden = !videoRun;
    if (!videoRun) $("#video-barre").value = 0;
    // Accueil seulement sans parcours ; bouton principal tant que rien n'est tracé
    $("#video-accueil").hidden = videoReady || tracing;
    $("#parcours-tracer").classList.toggle("principal", !videoReady && !tracing);
    $("#parcours-tracer").disabled = Boolean(videoRun);
    $("#parcours-tracer").setAttribute("aria-pressed", String(tracing));
    $("#parcours-tracer").textContent = tracing ? "📍 Tracé en cours : Échap pour terminer" : "📍 Tracer sur la carte";
    $("#parcours-ligne-etapes").hidden = !videoReady;
    showVideoPlan();
    scheduleVideoPlan();
    $("#interet-cible").disabled = !poiTargets.size || Boolean(videoRun);
    // Parcours gardé rouvert : grisé tant qu'il n'est pas modifié, puis il le remplace
    const changed = routeChanged();
    $("#parcours-garder").disabled = !videoReady || Boolean(videoRun) || (Boolean(openedRoute) && !changed);
    $("#parcours-garder").textContent = !openedRoute ? "☆ Garder" : changed ? "☆ Enregistrer…" : "☆ Gardé";
    $("#parcours-raz").disabled = Boolean(videoRun) || routeIsBlank();
    showPoiZone();  // portion du parcours concernée : suit la préparation, la cible et la zone
    for (const id of ["#video-vitesse", "#video-photos", "#video-flou", "#video-brouillon", "#video-stabilisation", "#video-expo", "#video-rampe", "#video-titre",
      "#video-compteur", "#video-compteur-vitesse", "#video-acceleration", "#video-vmax-arp", "#video-regard", "#video-tonneau", "#tonneau-duree", "#regard-vitesse",
      "#video-interet", "#interet-vitesse", "#interet-zoom", "#interet-zoom-distance", "#interet-tonneau",
      "#video-planete", "#planete-tout", "#planete-transition", "#planete-rotation", "#video-tour", "#tour-duree", "#tour-arret"]) {
      $(id).disabled = Boolean(videoRun);
    }
    updateFormats();
    travelPane.querySelector('.sur-carte[data-cote="planet"]').disabled = $("#planete-tout").checked;  // rien à tracer
    $("#planete-tonneau").disabled = Boolean(videoRun) || !Number($("#planete-transition").value);
    $("#video-mode").disabled = Boolean(videoRun);
    // Présentation et Brouillon : vitesse et rampe remplacées par l'allure ; Revue : l'inverse ; tout figé pendant le calcul
    if (presOptions()) $("#video-vitesse").disabled = $("#video-rampe").disabled = true;
    for (const id of ["#pres-vmax", "#pres-virage", "#pres-vmin", "#pres-transition", "#arret-duree", "#video-arret", "#ralenti-vitesse", "#video-ralenti"]) {
      $(id).disabled = Boolean(videoRun) || !presOptions();
    }
    for (const which of ["stop", "slow"]) travelPane.querySelector(`.sur-carte[data-cote="${which}"]`).disabled = Boolean(videoRun) || !presOptions();
    if ($("#video-brouillon").checked) {
      for (const id of DRAFT_OFF) $(id).disabled = true;
      for (const which of ["stop", "roll", "tour", "planet"]) travelPane.querySelector(`.sur-carte[data-cote="${which}"]`).disabled = true;
    }
    showModeHelp();  // mode rétabli par un parcours gardé ou la RAZ
    const stops = placed.waypoint.points.length;
    $("#parcours-etapes-infos").textContent = stops ? `${stops} étape${stops > 1 ? "s" : ""}, dans l'ordre de pose` : "aucune";
    $("#parcours-apercu").disabled = !preview && (!videoPlan || videoPlan.photos.length < 2 || Boolean(videoRun));
    $("#parcours-apercu").textContent = preview ? "■ Arrêter l'aperçu" : "▶ Aperçu";
    clearTimeout(allureTimer);
    allureTimer = setTimeout(showAllure, 300);  // tracé coloré : après une rafale de changements, une fois
    for (const id of ["#video-titre-texte", "#video-titre-sous", "#video-titre-rappel"]) {
      $(id).disabled = Boolean(videoRun) || !$("#video-titre").checked;  // sans titre, rien à régler
    }
    if (!videoRun) $("#video-info").textContent = videoOk ? videoInfo(seconds) : "ce navigateur n'encode pas la vidéo";
    // Écart des photos de chaque choix, d'après l'écart médian des photos du parcours préparé
    const gaps = plan.slice(1).map((p, i) => metresBetween(plan[i].coords, p.coords)).sort((a, b) => a - b);
    const gap = gaps[gaps.length >> 1];
    for (const option of $("#video-photos").options) {
      option.textContent = `Photos 1/${option.value}` + (gap ? ` · une tous les ${Math.round(gap * option.value)} m` : "");
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
    psv.addEventListener("sequence-stopped", () => {
      updatePlayer();
      refresh();  // hauteur de chute d'un pont : calculée hors lecture
    });
    psv.addEventListener("picture-loaded", (event) => {
      // Lecture rapide : photo demandée affichée, la suivante après la durée de transition de
      // la visionneuse (comme sa lecture 1x)
      if (fast && event.detail?.picId === fast.id) {
        const run = fast;
        run.timer = setTimeout(() => {
          if (run === fast) fastStep(run);
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
      : mode === "releve" ? "Relevé d'objets : visez l'objet depuis plusieurs photos puis « Valider le point triangulé », ou gardez-le sur une seule photo"
      : mode === "height" && aiming ? "Hauteur, étape 1 : visez le pied depuis plusieurs photos (flèches), puis « Valider le point triangulé »"
      : mode === "height" && newMeasure ? `Hauteur faite : cliquez une de ses croix pour l'ajuster ; autre hauteur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "height" ? "Hauteur, étape 2 : cliquez le sommet (le pied est le point visé) ; autre photo : par la carte"
      : mode === "road" && edgeBAiming ? "Largeur, bord opposé : le clic de la mesure est la 1re visée ; photo suivante, même bord (réticule calé sur le trait vert, Maj : visée libre), puis « Valider le point triangulé »"
      : mode === "road" && aiming ? "Largeur, étape 1 : visez le premier bord depuis plusieurs photos (flèches), de préférence un repère net (fin de tiret, joint, regard) ; réticule calé sur le trait vert, Maj : visée libre ; puis « Valider le point triangulé »"
      : mode === "road" && newMeasure ? `Largeur faite : cliquez une de ses croix pour l'ajuster ; autre largeur : « Nouvelle mesure depuis ${newMeasure} »`
      : mode === "road" ? "Largeur, étape 2 : cliquez le bord opposé ; autre photo, prise avant ou après : par la carte"
      : mode === "carte" ? `Longueur sur la carte : cliquez ${Dessus.hasStart() ? "l'arrivée" : "le départ"} sur la vue Bird Eye, de préférence en face de la caméra ; Échap : retirer le départ`
      : mode === "tilt" ? "Calage de l'inclinaison : pied puis sommet de deux objets verticaux, à 90° l'un de l'autre"
      : "Mode mesure en cours : désélectionner pour naviguer";
    // Nom de la mesure et étape déjà dans l'en-tête de la carte d'étape (« Hauteur, étape 1 : »…) : retirés
    const tip = $("#mode-mesure").textContent.replace(/^(?:Hauteur|Largeur|Mesure libre|Relevé d'objets|Longueur sur la carte|Calage de l'inclinaison)[^:]*: /, "");
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
      const label = choice.expect == null ? choice.label : `${choice.label} · ±${m(choice.expect)} m${choice.across ? " en travers" : ""}`;
      const title = choice.expect == null ? choice.title : `${choice.title}. Incertitude attendue ${choice.across ? "en travers de la route" : "du point"} : `
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
    if (json !== releveSaved || !poiTargets.size !== !n) refreshPoiTargets(json);
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
        noticeInFullscreen("Vignette enregistrée et copiée dans le presse-papiers.");
      } catch {
        setStatus("Vignette enregistrée (copie dans le presse-papiers refusée par le navigateur).");
        noticeInFullscreen("Vignette enregistrée (copie dans le presse-papiers refusée par le navigateur).");
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
    const run = { apis, ids: new Map(), points: new Map(), step: offset };  // points : rempli par loadRanks
    await loadRanks(run, rank + offset).catch((error) => console.warn("Photo décalée dans la séquence :", error));
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
    if (photo) data.place = (await Lieu.describe(...photo.geometry.coordinates.slice(0, 2), photo).catch(() => ({}))).parts;  // déjà lu : sans requête
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
  window.mesures = { refresh, get app() { return app; }, get psv() { return psv; }, get videoPlan() { return videoPlan; }, get touring() { return Boolean(tour); }, map, openPhoto, buildFiche, paginateFiche, photoAtOffset, importOverlay, thumbnail,
    overlayFile: (handle) => { overlay.fichier = handle; } };  // fichier de la couche remplacé (essais)
})();
