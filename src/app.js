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
  // État modifiable partagé entre les parties de la page (et lu par Fiche, Parcours) : etat.photo, etc.
  const etat = {
    lastLights: [],  // voyants affichés (redessinés quand un service se tait ou répond)
    tiltReason: null,  // pourquoi l'inclinaison automatique manque (state.tilt_reason, ticket #29)
    app: null,  // web_app.App, une fois Pyodide chargé
    photo: null,  // fiche STAC de la photo affichée
    psv: null,  // visionneuse sphérique (Photo Sphere Viewer) dans <pnx-photo-viewer>
    savedCalibration: -1,  // version du calage déjà enregistrée dans le navigateur
    measuring: false,  // bouton « Mesure » : clics dans la photo pour mesurer, sans navigation
    edgeProfile: null,
    apiUrl: null,  // adresse de l'API de l'instance (Carte.setInstance)
    swapped: false,
    placing: false,
    lineDraft: null,  // pendant le tracé : point de départ (LngLat), ou false avant le premier clic
    pointSelected: false,
    mapWindow: null,
    overlay: null,  // { name, features (WGS 84, Couche.read), columns, crs }
    moving: null,  // { id, photo } : objet en cours de recalage
    objectCurrent: null,  // n° de l'objet du parcours
    addingObject: false,
    overlaySaving: Promise.resolve(true),
    slideKind: null,  // réticule affiché : "largeur", "hauteur" (trait jaune en travers), ou null
    heightAxis: null,  // hauteur : [pied, sommet] de la 1re hauteur depuis A (App.height_axis), ou null
    crossAt: [],  // croix sélectionnables (drawViewerMarks) : [[cap, élévation]]
    aiming: false,
    pointReady: false,  // visées qui donnent un point (bouton « Valider le point triangulé »)
    singleM: null,  // relevé, une seule visée : précision (m) de l'objet gardé sur cette photo
    tiltReady: false,  // calage de l'inclinaison : pied et sommet placés (bouton « Valider l'objet vertical »)
    newMeasure: null,  // largeur faite : nom du point de référence (bouton « Nouvelle mesure depuis A »)
    lineDrawn: false,  // droite de mesure tracée sur la carte, en attente du point A (#28)
    edgeBOffered: null,  // largeur faite d'un clic : nom (provisoire) de son bord, à trianguler
    edgeBAiming: false,  // bord opposé de la largeur en cours de triangulation
    tilted: false,  // inclinaison de la photo affichée calée
    currentMarks: [],
    declutterTimer: null,
    guideShown: null,  // dernières photos proposées : flèches refaites quand la vue tourne
    exported: null,  // export GeoJSON (commentaires compris) lors du dernier export
    saveTimer: null,
  };
  const silent = new Set();  // noms des services sans réponse
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
  /** Réponse JSON lisible : les services gardés n'en rendent pas d'autre. La Géoplateforme renvoie parfois, avec un statut 200,
   * sa page de statistiques (« # HELP jmx… », 20/11/2026) : gardée 90 jours, elle était resservie à chaque essai
   * (« Analyse fine impossible : Unexpected token '#' », 5331221f-7a1f-4ace-b4de-9cf94a57e4d2). */
  function readable(text) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  async function storeGeo(cache, url, response) {
    const text = await response.text();
    if (!readable(text)) return;  // pas gardée : le prochain appel redemande au service
    const headers = new Headers(response.headers);
    headers.set("x-mis-en-cache", String(Date.now()));
    headers.set("x-vide", emptyAnswer(text) ? "1" : "0");
    headers.set("x-taille", String(new Blob([text]).size));
    await cache.put(url, new Response(text, { status: response.status, statusText: response.statusText, headers }));
    if (geoStored++ % 50 === 0) pruneIfFull();  // taille contrôlée de temps en temps
  }
  /** Nettoyage (pruneGeoCache, qui relit tout le cache) seulement si le stockage de la page dépasse CACHE_MAX :
   * l'occupation totale (navigator.storage.estimate, sans relire le cache) en est une borne haute. */
  async function pruneIfFull() {
    const usage = (await navigator.storage?.estimate?.().catch(() => null))?.usage;
    if (usage == null || usage > CACHE_MAX) await pruneGeoCache();
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
  // Stockage du navigateur sans réponse (Cache API bloquée : vu dans Chrome tué en pleine écriture, 16/11/2026 ; la page
  // attendait sans fin) : chaque ouverture ou lecture du cache a CACHE_WAIT ms, sinon la requête part au service ;
  // CACHE_GIVE_UP délais dépassés d'affilée : cache abandonné pour la session (page et nuage LiDAR, src/nuage.js)
  const CACHE_WAIT = 3000, CACHE_GIVE_UP = 3;
  let cacheLate = 0, cacheAbandoned = false;
  /** promise (étape du cache), ou fallback si elle tarde plus de CACHE_WAIT ms ; une lecture à temps (reset) remet le
   * compte des retards à zéro, pas l'ouverture (promesse déjà résolue, sans rien dire du stockage). */
  async function cacheStep(promise, fallback = null, reset = true) {
    let late = false;
    const value = await Promise.race([promise, new Promise((resolve) => setTimeout(() => { late = true; resolve(fallback); },
      CACHE_WAIT))]);
    if (!late) cacheLate = reset ? 0 : cacheLate;
    else if (++cacheLate >= CACHE_GIVE_UP && !cacheAbandoned) {
      cacheAbandoned = true;
      geoCache = Promise.resolve(null);
      console.warn("Cache des données géographiques sans réponse : abandonné pour cette session.");
    }
    return value;
  }
  Nuage.useGeoCache(() => cacheStep(openGeoCache(), null, false), cacheStep);
  /** Requête d'un service gardé, redemandée une fois en contournant le cache HTTP du navigateur si la réponse (200) est
   * illisible : la Géoplateforme renvoie parfois sa page de statistiques « # HELP jmx… » (text/plain, cache-control
   * max-age de 21 jours) au lieu du JSON ; le cache HTTP de Chrome la garde et la resservait à chaque requête vers la
   * même adresse (« BD TOPO injoignable : Expecting value », 20/11/2026, 20a5b40f-ab06-40ab-97e1-b3f74032bec7).
   * `cache: "reload"` va au service et remplace l'entrée. Seconde réponse encore illisible : rendue telle quelle
   * (storeGeo ne la garde pas). */
  async function geoFetch(input, init) {
    const response = await trackedFetch(input, init);
    if (!response.ok || readable(await response.clone().text().catch(() => ""))) return response;
    return trackedFetch(input, { ...init, cache: "reload" });
  }
  window.fetch = async (input, init) => {
    const url = input?.url ?? String(input);
    const gardee = geoCacheable(url, init);
    const cache = gardee ? await cacheStep(openGeoCache(), null, false) : null;
    if (!cache) return gardee ? geoFetch(input, init) : trackedFetch(input, init);
    let hit = await cacheStep(cache.match(url).catch(() => undefined), undefined);
    if (hit && !readable(await hit.clone().text().catch(() => ""))) {  // gardée avant le contrôle de storeGeo : jetée
      cache.delete(url).catch(() => {});
      hit = undefined;
    }
    const age = hit ? Date.now() - Number(hit.headers.get("x-mis-en-cache")) : Infinity;
    if (hit && age < (hit.headers.get("x-vide") === "1" ? CACHE_EMPTY_LIFE : CACHE_LIFE)) return hit;
    try {
      const response = await geoFetch(input, init);
      if (response.ok) storeGeo(cache, url, response.clone()).catch((error) => console.warn("Cache :", error));
      return !response.ok && hit ? hit : response;  // refus ou erreur : la réponse plus ancienne
    } catch (error) {
      if (hit && error?.name !== "AbortError") return hit;  // service muet ou en panne : idem
      throw error;
    }
  };

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

  const viewer = $("#visionneuse");
  // Carte ouverte d'emblée sur la photo que rouvre reopenPhoto : sans détour par la Côte-d'Or au zoom 9, dont fond,
  // filaire et limites se chargeaient pour rien ; position gardée de la dernière photo, ou celle de la photo par
  // défaut (DEFAULT_PHOTO, première visite) ; sinon la Côte-d'Or
  const DEFAULT_PLACE = [4.469816, 47.53666];  // DEFAULT_PHOTO, Venarey-les-Laumes
  const lastPlace = (() => {
    if (store.get("defauts") !== "1" || !store.get("photo")) return { center: DEFAULT_PLACE, zoom: 17 };
    try {
      const at = JSON.parse(store.get("photo-lieu") || "null");
      return Array.isArray(at) && at.length === 2 && at.every(Number.isFinite) ? { center: at, zoom: 17 } : {};
    } catch {
      return {};
    }
  })();
  const map = Carte.createMap("carte", { vectorPlan: true, ...lastPlace });  // Plan IGN vectoriel : texte net à tout zoom
  Recherche.attach(map);
  Requeteur.attach(map, (...args) => openNearest(...args));  // choix de la photo : déclaré plus bas
  Carte.showMilestones(map);

  // Services : bilan dans la section, point rouge sur son bouton du pied s'il en manque ; vérifiés une fois le calcul
  // prêt (ou en échec) : leurs requêtes ne retardent pas Pyodide
  const checkServices = () => Services.checkServices($("#reseau ul"), (ok, failed, total) => {
    const waiting = total - ok - failed;
    $("#reseau-infos").textContent = failed ? `${failed} sans réponse ou bloqué${failed > 1 ? "s" : ""} sur ${total}`
      : `${ok} services sur ${total} accessibles${waiting ? ` · ${waiting} en cours` : ""}`;
    $("#services-alerte").textContent = failed ? "●" : "";
  });
  // Cache des informations géographiques : taille, et bouton pour le vider
  async function showGeoCache() {
    const size = await pruneGeoCache();
    $("#vider-cache").disabled = !size;  // indisponible (null) ou déjà vide
    $("#vider-cache").textContent = cacheAbandoned ? "Cache sans réponse : abandonné pour cette session"
      : size === null ? "Cache indisponible (page ouverte en fichier local)"
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
    // sans calcul (ouverture de la page) : bouton déjà grisé (index.html), et showFolderExport pas encore prêt (Releve.init)
    if (id === "reglages" && etat.app) showFolderExport();
  }
  for (const button of paneButtons) button.addEventListener("click", () => showPane(button.dataset.panneau));
  showPane(store.get("panneau", "resultats"));
  $("#vider-cache").addEventListener("click", async () => {
    await pruneGeoCache(0);
    showGeoCache();
  });

  // Fond, instance, centrage ----------------------------------------------------------------

  // Réglages de l'affichage (filaire, inclinaison, bords, PR, cadastre…) et fenêtre du profil : src/reglages.js
  Reglages.init({
    store, map, etat, refresh, showOverViewer, mainZone, saveAs, setStatus, FICHE_FONTS, placeMarkup, escapeHtml,
    get applyMeasureUi() { return applyMeasureUi; }, get endLineDraft() { return endLineDraft; },
    get showParcelMark() { return showParcelMark; },
  });

  // Réglages par défaut : l'instance de l'IGN et les photos du conseil départemental de la
  // Côte-d'Or (positions RTK, LiDAR HD : ce que demandent les calculs). Appliqués une fois, même
  // dans un navigateur qui avait déjà ses réglages ; chacun peut ensuite en changer.
  const DEFAULT_INSTANCE = "https://panoramax.ign.fr";
  const DEFAULT_PRODUCER = ["8f943f10-a781-4e03-a18c-de035be6f6f8", "conseil départemental de la côte-d'or"];
  // Photo ouverte à la première utilisation (et sans dernière photo gardée) : Venarey-les-Laumes (D103T), route plate et droite,
  // vue tournée vers le bâtiment rond sur la gauche (cap en degrés). L'ancienne (Semur-en-Auxois,
  // 7752eb30-a733-4213-b57a-5d5086e261a4) était sur un
  // pont pavé : vue Bird Eye sans LiDAR, voie rétrécie
  const DEFAULT_PHOTO = "8625c7ff-90c1-4865-b936-fd8952ac908f";  // position : DEFAULT_PLACE
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
  etat.apiUrl = Carte.setInstance(map, savedInstance);
  viewer.setAttribute("endpoint", etat.apiUrl);
  Carte.instances().then((list) => {
    for (const [name, url] of list) {
      if (url !== savedInstance) instance.append(new Option(name, url));
      else instance.options[1].text = name;
    }
  }).catch((error) => console.warn("Instances Panoramax :", error));
  instance.addEventListener("change", () => {
    store.set("instance", instance.value);
    etat.apiUrl = Carte.setInstance(map, instance.value);
    viewer.setAttribute("endpoint", etat.apiUrl);
    etat.app?.set_api_url(etat.apiUrl);
    checkPhoto();
    updatePlayer();  // parcours gardé rouvert : modifié (« ☆ Enregistrer… »)
  });

  // Hauteur de la carte, plein écran de la visionneuse, largeur de la colonne : src/disposition.js
  const { mapBox, grip, fold, setFolded, columnFold, setColumnFolded } = Disposition.init({
    map, store, setStatus,
    setSwapped: (on) => setSwapped(on),  // résultats : déclaré plus bas
    wantSwap: () => wantSwap(),  // déclaré plus bas
  });

  // « Largeur dans la visionneuse » (expérimental) : droite au sol devant le véhicule, poignées à glisser : src/nez.js
  const nez = Nez.init({ etat, map, get notice() { return notice; } });

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

  /** Texte sûr dans du HTML (étiquettes, infobulles, fiches). */
  function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  /** Lieu (texte « D104 – PR 16 +0880 – … – Aubaine ») en HTML : la route et la commune (parts de
   * Lieu.describe) en gras, le reste (PR, nom de la voie, hameau) en texte normal. */
  function placeMarkup(text, parts) {
    const strong = [parts?.voieAffichee || parts?.voie, parts?.commune].filter(Boolean);
    return text.split(" – ").map((part) => (strong.includes(part) ? `<b>${escapeHtml(part)}</b>` : escapeHtml(part))).join(" – ");
  }
  async function showPlace(feature, attempt = 0) {
    const [lon, lat] = feature.geometry.coordinates;
    const { text, complete, parts } = await Lieu.describe(lon, lat, feature);
    if (etat.photo !== feature) return;
    if (text || complete) {
      $("#lieu").innerHTML = placeMarkup(text, parts);
      $("#lieu").hidden = !text;
    }
    if (!complete && attempt < PLACE_RETRY.length) {
      setTimeout(() => { if (etat.photo === feature) showPlace(feature, attempt + 1); }, PLACE_RETRY[attempt]);
    }
  }

  /** Dernière photo de la visite précédente, rouverte et centrée sur la carte. */
  async function reopenPhoto() {
    const saved = store.get("photo");
    const id = firstUse || !saved ? DEFAULT_PHOTO : saved;  // première utilisation : la photo par défaut
    if (etat.photo) return;  // photo déjà choisie entre-temps
    try {
      const feature = await Carte.photoById(id);
      if (!feature || etat.photo) return;  // photo supprimée depuis, ou autre photo choisie
      if (etat.app && !passesFilter(feature)) return;  // sinon vérifiée au chargement du calcul
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
      if (Date.now() - t0 > 30000 || (etat.photo && etat.photo.id !== feature.id)) {
        clearInterval(timer);  // trop long, ou autre photo choisie entre-temps
        return;
      }
      if (etat.psv?.getPictureMetadata?.()?.id !== feature.id) return;
      clearInterval(timer);
      const azimuth = Number(feature.properties?.["view:azimuth"]) || 0;  // cap du centre de la photo
      const yaw = (((heading - azimuth) % 360 + 540) % 360 - 180) * Math.PI / 180;
      setTimeout(() => etat.psv.rotate({ yaw, pitch: 0 }), 300);  // après la mise en place de la vue
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
    const c = JSON.parse(etat.app.calibration_json());
    $("#calage-exporter").disabled = !["verticals", "landmarks", "heights", "auto"]
      .some((k) => c[k] && Object.keys(c[k]).length);
  }

  Calcul.startCalcul(() => refresh(), etat.apiUrl).then((created) => {
    etat.app = created;
    // Relevé gardé : relu avant tout rafraîchissement, qui écrirait par-dessus un relevé vide
    try { etat.app.load_releve(store.get("releve") || ""); } catch (error) { console.warn("Relevé gardé illisible :", error); }
    const saved = store.get("calage");
    if (saved && !etat.app.load_calibration(saved)) console.warn("Calage enregistré illisible : ignoré.");
    etat.savedCalibration = etat.app.calibration_version;
    for (const id of ["#mesure", "#mode", "#camera", "#pont", "#calage-importer"]) $(id).disabled = false;
    showCalibrationExport();
    $("#camera").value = store.get("camera", $("#camera").value);
    etat.app.set_camera_height(Number($("#camera").value));
    etat.app.set_terrain_relay($("#inclinaison-terrain").checked);
    etat.app.set_edge_zone(Number($("#bords-largeur").value));
    applyFilter(false);
    if (etat.photo) etat.app.set_picture(JSON.stringify(etat.photo));
    restoreOverlay();  // couche importée gardée de la session précédente
    showModeOptions();
    refresh();
  }).catch((error) => {
    console.error(error);
    setStatus(`Calcul indisponible : ${error.message}`, "echec");
  }).finally(checkServices);

  /** Voyants de la visionneuse : RTK et sol (LiDAR HD ou RGE ALTI) toujours ; inclinaison calée en
   * mode mesure seulement (elle n'est calculée qu'au premier clic de mesure). */
  function showLights(lights = etat.lastLights) {
    etat.lastLights = lights;
    const list = $("#voyants");
    // Inclinaison : en mesure seulement, sauf en mesure libre (pas calculée, visées en cap)
    const shown = etat.measuring && $("#mode").value !== "tri" ? lights : lights.filter(([name]) => name !== "Inclinaison");
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
    message.hidden = !etat.measuring || triangulating || $("#mode").value === "carte"
      || !(calibrating || tilt === "attente" || manual || before);
    message.classList.toggle("manuel", manual);
    message.classList.toggle("calage", calibrating);
    message.classList.toggle("attente", tilt === "attente");  // petite roue : calcul en cours
    if (etat.tilted !== (tilt === "ok")) {
      etat.tilted = tilt === "ok";
      applyMeasureUi();  // pointeur : cercle vert
    }
    message.textContent = calibrating
      ? "Calage vertical" + (tilt === "attente" ? " · calcul automatique en cours" : "")
      : before
        ? "Inclinaison calculée automatiquement au premier clic sur la photo"
        : manual
          ? `Inclinaison non calée${etat.tiltReason ? ` : ${etat.tiltReason}` : ""}. `
            + "Les mesures sont moins précises ; leur incertitude en tient compte."
          : "Calcul de l'inclinaison en cours : attendez avant de mesurer";
  }

  /** Grande zone principale (là où est la visionneuse sans échange) : la visionneuse elle-même, ou, carte et visionneuse
   * échangées, son gabarit (#place-vue), où la carte s'est posée. */
  function mainZone() { return etat.swapped ? $("#place-vue") : $("#vue"); }

  /** Fenêtre modale centrée sur la visionneuse (et non sur la page), recentrée si la fenêtre du
   * navigateur change de taille. Avec `onMainZone`, elle se centre sur la grande zone principale, que la visionneuse ou la
   * carte y soit (carte et visionneuse échangées) : toujours au même endroit à l'écran. Seule la fenêtre du graphique du
   * profil le demande ; les autres fenêtres suivent la visionneuse. */
  function showOverViewer(dialog, onMainZone = false) {
    dialog.showModal();
    let bottom = null;  // bas de la fenêtre une fois placée : gardé quand son contenu change (case actionnée, légende plus
    // courte), pour que ses boutons, en bas, ne sautent pas sous le pointeur ; sans sortir de la visionneuse
    const place = () => {
      const box = (onMainZone ? mainZone() : $("#vue")).getBoundingClientRect();
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
    dialog.addEventListener("recentrer", resized);  // contenu replié ou déplié par l'utilisateur : recentrée, comme à l'ouverture
    const grown = new ResizeObserver(place);  // contenu changé fenêtre ouverte (modèle choisi, champs ajoutés)
    grown.observe(dialog);
    dialog.addEventListener("close", () => {
      window.removeEventListener("resize", resized); dialog.removeEventListener("recentrer", resized); grown.disconnect();
    }, { once: true });
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
    refresh(etat.app.use_bridge_lidar(ask.key, JSON.stringify(answer)));
  }

  function refresh(text) {
    if (!etat.app) return;
    setStatus(text ?? etat.app.status());
    nez.changed();  // droite de la largeur dans la visionneuse, si l'inclinaison ou la hauteur de caméra ont changé
    updateBirdeye();
    const rtkAlert = etat.app.take_rtk_alert();  // séquence sans RTK : fenêtre, une fois par séquence
    if (rtkAlert && !$("#alerte-rtk").open) {
      $("#alerte-rtk p").textContent = rtkAlert;
      showOverViewer($("#alerte-rtk"));
    }
    // Photo sur un pont (BD TOPO) : « Sur un pont » proposé, une fois par pont ; sortie du pont : la
    // décocher, une fois par sortie. Sans autre fenêtre ouverte.
    const bridgeAlert = document.querySelector("dialog[open]") ? null : JSON.parse(etat.app.take_bridge_alert());
    if (bridgeAlert) {
      const dialog = $("#alerte-pont");
      dialog.querySelector("h2").textContent = bridgeAlert.check ? "⚠ Photo sur un pont" : "Sortie du pont";
      dialog.querySelector("p").textContent = bridgeAlert.text;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => {
        if (dialog.returnValue !== "oui") return;
        $("#pont").checked = bridgeAlert.check;
        refresh(bridgeAlert.check ? etat.app.set_bridge(true) : etat.app.leave_bridge());
      }, { once: true });
      showInCorner(dialog);
    }
    const state = JSON.parse(etat.app.state());
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
    etat.tiltReason = state.tilt_reason;
    showLights(state.lights);
    // Photo sur un pont, en haut à gauche : nom et hauteur de chute ; ailleurs, chute et dévers des
    // bords de route après un appui sur « Profils » (pas pendant la lecture)
    const fall = playing() ? null : JSON.parse(etat.app.fall_json());
    const [bridge, ...rest] = (fall?.text || "").split("\n");
    Object.assign($("#chute"), { hidden: !fall, title: fall?.title || "" });
    $("#bords").disabled = playing() || (fall && !fall.edges) || !etat.app.edges_ready();  // pas sur un pont
    etat.edgeProfile = fall?.profile ? fall : null;
    if (fall?.lidar) readBridgeFall(fall.lidar);
    $("#profil").disabled = !etat.edgeProfile;
    // Nom du pont en vert, « Au-dessus de … » en bleu, puis la hauteur
    const line = (text, className) => Object.assign(document.createElement("span"), { className, textContent: text });
    $("#chute").replaceChildren(line(bridge, "pont"),
      ...rest.flatMap((t) => ["\n", t.startsWith("Au-dessus") ? line(t, "dessus") : t]));
    if (fall?.ask) {  // hauteur de caméra ni mesurée ni calée : le réglage, si l'utilisateur l'accepte (App.use_fall_setting)
      const ask = Object.assign(document.createElement("button"), { type: "button", className: "chute-reglage", textContent: fall.ask });
      ask.addEventListener("click", () => refresh(etat.app.use_fall_setting()));
      $("#chute").append("\n", ask);
    }
    etat.pointReady = state.point;
    etat.singleM = state.single_m;
    etat.tiltReady = state.tilt_ready;
    etat.pointSelected = state.point_sel;
    if (etat.aiming !== state.aiming || etat.newMeasure !== state.new_measure || etat.edgeBAiming !== state.edge_b_aiming) {
      etat.aiming = state.aiming;  // point validé ou à trianguler, largeur faite, bord opposé en visée
      etat.newMeasure = state.new_measure;
      etat.edgeBAiming = state.edge_b_aiming;
      applyMeasureUi();
    }
    etat.edgeBOffered = state.edge_b;
    showModeOptions();  // « Valider le point triangulé » : dès que les visées donnent un point
    showGuide(state.guide);
    // Retour sur la photo de référence : vue cadrée sur A, ou sur la largeur, une fois la photo
    // affichée (avant, son chargement remettrait la vue d'origine)
    if (photoReady()) frameView(JSON.parse(etat.app.take_frame()));
    // Visées suivantes (point de référence, bord B) : vue tournée vers le point, zoom gardé
    if (photoReady()) frameView(JSON.parse(etat.app.take_aim_frame()), true);
    if (etat.app.calibration_version !== etat.savedCalibration) {
      etat.savedCalibration = etat.app.calibration_version;
      store.set("calage", etat.app.calibration_json());
      showCalibrationExport();
    }
    drawViewerMarks(JSON.parse(etat.app.viewer_marks()));
    etat.heightAxis = JSON.parse(etat.app.height_axis());
    if ((!etat.heightAxis && etat.slideKind === "hauteur") || (!etat.aiming && etat.slideKind === "visée")) slideOnGuide(null);
    Carte.showMeasures(map, JSON.parse(etat.app.map_geojson()));
    Carte.showHandles(map, JSON.parse(etat.app.handles()), (index, lon, lat) => refresh(etat.app.move_handle(index, lon, lat)));
    frame(etat.app.focus());
    showResults(JSON.parse(etat.app.results()));
    saveResults();
    const results = etat.app.has_results();
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

  // Résultats, carte et visionneuse échangées, boutons de la carte (Bird Eye, capture, export) : src/resultats.js
  const {
    setSwapped, wantSwap, updateBirdeye, showResults, proposeDistance, swapButton, measureButton, birdeyeButton,
    captureButton, exportButton, showMapMeasureButton, syncMapMeasure, showResultsInfo,
  } = Resultats.init({
    etat, refresh, askFiche, showOverViewer, map, mapBox, setColumnFolded, setFolded, fold, columnFold, notice, nez,
    get coneHeading() { return coneHeading; }, get editReleve() { return editReleve; },
    get saveResults() { return saveResults; }, get viewFov() { return viewFov; }, get applyMeasureUi() { return applyMeasureUi; },
  });

  // Choix de la photo sur la carte, carte détachée, tracés et recalages au clavier : src/choix.js
  const {
    openNearest, endLineDraft, checkPhoto, openPhoto, overlayObjectName, overlayFicheData, overlayEnds,
    proposeRecaledPhoto, reviewMeasure, endMoving, moveOverlayObject, placeOverlayObject, setPhoto, follow, metresBetween,
    overlayPoints, setPlacing, showDrawnLine, startLineDraft,
  } = Choix.init({
    map, setStatus, etat, refresh, passesFilter, filterActive, viewer, notice, showOverViewer,
    proposeDistance, setSwapped, mapBox, setFolded, grip, swapButton, measureButton, birdeyeButton, captureButton,
    exportButton, store, photoProducer, updateProducers, showPlace, nez,
    // favoris et photo éloignée : déclarés plus bas (Favoris.init)
    showPhotoInfo: (...args) => showPhotoInfo(...args), showFavorites: (...args) => showFavorites(...args),
    checkFarFromMeasures: (...args) => checkFarFromMeasures(...args),
    get ZONE_ID() { return ZONE_ID; }, get addObjectAt() { return addObjectAt; },
    get applyMeasureUi() { return applyMeasureUi; }, get attachViewer() { return attachViewer; },
    get coneHeading() { return coneHeading; }, get drawViewerMarks() { return drawViewerMarks; },
    get editReleve() { return editReleve; }, get frameView() { return frameView; }, get movingId() { return movingId; },
    get openPhotoReady() { return openPhotoReady; }, get overlayAt() { return overlayAt; },
    get overlayLabels() { return overlayLabels; }, get overlayProperties() { return overlayProperties; },
    get parcours() { return parcours; }, get pickTravelPoint() { return pickTravelPoint; },
    get playing() { return playing; }, get poi() { return poi; }, get saveOverlay() { return saveOverlay; },
    get setAddingObject() { return setAddingObject; }, get setOverlayChanged() { return setOverlayChanged; },
    get setTravelPick() { return setTravelPick; }, get showModeOptions() { return showModeOptions; },
    get showObjectState() { return showObjectState; }, get showOverlayInfo() { return showOverlayInfo; },
    get showPlanets() { return showPlanets; }, get showPoiZone() { return showPoiZone; },
    get updatePlayer() { return updatePlayer; }, get viewFov() { return viewFov; },
  });

  // Photo loin des mesures, aller à une photo, favoris : src/favoris.js
  const {
    showPhotoInfo, showFavorites, checkFarFromMeasures, favorites, importFavorites,
  } = Favoris.init({
    etat, refresh, showOverViewer, photoProducer, openPhoto, map, store, notice, download, exportName,
    get stopPlayer() { return stopPlayer; },
  });

  // Couche importée dans la page (filtre, tableau des objets, recalages, ajout) et import commun : src/objets.js
  const {
    restoreOverlay, addObjectAt, setAddingObject, overlayAt, overlayProperties, overlayLabels, showObjectState,
    setOverlayChanged, saveOverlay, showOverlayInfo, movingId, fileInput, ask, overlayHiddenTest,
    exportOverlay, loadOverlay, setOverlayFile, overlaySaved, applySavedOverlay, UUID, importOverlay,
    fileStore,
  } = Objets.init({
    etat, setStatus, map, refresh, overlayObjectName, overlayFicheData, overlayEnds, notice, proposeRecaledPhoto, store,
    reviewMeasure, download, showOverViewer, askFiche, importFavorites,
    get DOSSIER_FORMAT() { return DOSSIER_FORMAT; }, get MODELES_FORMAT() { return MODELES_FORMAT; },
    get fieldsError() { return fieldsError; }, get frameView() { return frameView; },
    get importCalibration() { return importCalibration; }, get importFolder() { return importFolder; },
    get importModels() { return importModels; }, get importRoutes() { return importRoutes; },
    get openPhotoReady() { return openPhotoReady; }, get overlayFields() { return overlayFields; },
  });

  // Visionneuse (cap, champ, chargement des photos, flèches, clics) : src/visionneuse.js
  const {
    slideOnGuide, coneHeading, viewFov, attachViewer, viewHeading,
  } = Visionneuse.init({
    etat, map, viewer, nez, askFiche, movingId, endMoving, moveOverlayObject, placeOverlayObject, refresh, remindZoom,
    passesFilter, setPhoto, notice, get LOADING() { return LOADING; }, get applyMeasureUi() { return applyMeasureUi; },
    get attachPlayer() { return attachPlayer; }, get onArrow() { return onArrow; },
    get photoReady() { return photoReady; }, get reticleColor() { return reticleColor; },
    get scheduleDeclutter() { return scheduleDeclutter; }, get showGuide() { return showGuide; },
    get stopPlayer() { return stopPlayer; }, get waitParcelTiles() { return waitParcelTiles; },
  });

  // Lecture de la séquence et onglet « Vidéo » (parcours, effets, parcours gardés, vidéo) : src/parcours.js
  const parcours = Parcours.init({
    get psv() { return etat.psv; }, get photo() { return etat.photo; }, get app() { return etat.app; },
    get measuring() { return etat.measuring; },
    map, viewer, store, instance, follow, metresBetween, setStatus, refresh, showPane, fileInput, ask, passesFilter,
    filterActive, notice, applyFilter, addProducer, saveAs, exportName, download,
  });
  const {
    updatePlayer, stopPlayer, playing, attachPlayer, loadRanks, savedRoutes, importRoutes, poi, ZONE_ID, showPoiZone,
    showPlanets, setTravelPick, pickTravelPoint, refreshPoiTargets,
  } = parcours;

  // Bouton « Mesure », visées guidées, mode et réglages de la mesure : src/mesure.js
  const {
    applyMeasureUi, showParcelMark, showModeOptions, showGuide, photoReady, frameView, drawViewerMarks,
    openPhotoReady, reticleColor, onArrow, LOADING, scheduleDeclutter, waitParcelTiles, goToPhoto,
  } = Mesure.init({
    etat, showMapMeasureButton, viewer, stopPlayer, syncMapMeasure, updatePlayer, refresh, overlayAt, overlayHiddenTest,
    movingId, overlayPoints, viewHeading, openPhoto, notice, setPlacing, showDrawnLine, store, startLineDraft,
    proposeDistance, escapeHtml,
    editReleve: (k, fresh) => editReleve(k, fresh),  // relevé : déclaré plus bas (Releve.init)
  });

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
    return etat.app ? etat.app.filter_matches(JSON.stringify(feature)) : !filterActive();
  }

  function applyFilter(save = true) {
    const f = currentFilter();
    if (save) store.set("filtre", JSON.stringify(f));
    Carte.setFilter(map, f);
    if (etat.app) etat.app.set_filter(JSON.stringify(f));
    const active = filterActive();
    $("#filtre-actif").textContent = active ? "●" : "";
    $("#filtre-actif").title = active && etat.app ? etat.app.filter_text() : "";
    $("#filtre-infos").textContent = !active ? "aucun" : etat.app ? etat.app.filter_text() : "en attente du calcul";
    if (etat.app) checkPhoto();  // sans le calcul, le filtre n'est pas encore évalué
  }

  /** Clic de mesure trop peu zoomé (un pixel de l'écran couvre plus de 2 pixels de la photo) :
   * rappel de zoomer, une fois par photo. */
  const zoomReminded = new Set();
  function remindZoom() {
    const width = etat.psv.state.textureData?.panoData?.fullWidth || 12288;  // photo HD imajbox
    const height = etat.psv.container.clientHeight;
    if (!etat.photo || zoomReminded.has(etat.photo.id) || !height || viewFov(true) / height <= 2 * 360 / width) return;
    zoomReminded.add(etat.photo.id);
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
    const producer = etat.app ? JSON.parse(etat.app.producer()) : null;
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


  $("#csv").addEventListener("click", async () => {
    const geojson = etat.app.export_geojson();
    if (await download("\ufeff" + etat.app.export_csv(), await exportName("mesures", "csv", true), "text/csv")) etat.exported = geojson;
    saveResults();
    showResultsInfo();
  });
  $("#geojson").addEventListener("click", async () => {
    const geojson = etat.app.export_geojson();
    if (await download(geojson, await exportName("mesures", "geojson", true), "application/geo+json")) etat.exported = geojson;
    saveResults();
    showResultsInfo();
  });

  // Relevé d'objets, dossier de travail, modèles de champs, import des calages : src/releve.js
  const {
    showFolderExport, saveResults, saveReleve, editReleve, fieldsError, overlayFields, importModels, importCalibration,
    importFolder, DOSSIER_FORMAT, MODELES_FORMAT,
  } = Releve.init({
    store, etat, parcours, refreshPoiTargets, exportOverlay, showOverViewer, loadOverlay, setOverlayFile,
    setOverlayChanged, saveOverlay, showPane, refresh, setStatus, download, exportName, fileInput, map, savedRoutes,
    favorites, overlaySaved, notice, applySavedOverlay, importRoutes, importFavorites, UUID, goToPhoto,
  });

  // Enregistrement des fichiers ---------------------------------------------------------------

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

  /** Nom d'un fichier exporté : sorte, route et PR de la photo affichée (place, s'ils sont lus en 0,5 s), date du jour ;
   * « mesures D974 PR12 2026-11-15.csv ». */
  async function exportName(kind, ext, place = false) {
    const timeout = new Promise((resolve) => setTimeout(resolve, 500));  // le geste qui autorise l'enregistrement dure 5 s
    const parts = place && etat.photo
      ? (await Promise.race([Lieu.describe(...etat.photo.geometry.coordinates.slice(0, 2), etat.photo), timeout])
      .catch(() => null))?.parts : null;
    const date = new Date().toLocaleDateString("sv-SE");  // AAAA-MM-JJ, à l'heure locale
    return `${[kind, parts?.voie, parts?.pr, date].filter(Boolean).join(" ").replace(/[\\/:*?"<>|]/g, "-")}.${ext}`;
  }
  /** Contenu enregistré dans le fichier name (saveAs) ; faux si l'utilisateur a renoncé. */
  async function download(content, name, type) {
    const save = await saveAs(name, type);
    if (save) await save(content);
    return Boolean(save);
  }

  window.addEventListener("beforeunload", (event) => {
    if (etat.app && etat.app.has_results() && etat.app.export_geojson() !== etat.exported) event.preventDefault();  // non exportés
  });

  // Captures et fiches PDF : src/fiche.js (Fiche)
  Fiche.init({
    get app() { return etat.app; }, get photo() { return etat.photo; }, get psv() { return etat.psv; },
    get overlay() { return etat.overlay; },
    map, mapBox, setStatus, noticeInFullscreen, escapeHtml, placeMarkup, saveAs, viewFov, viewHeading, frameView,
    showOverViewer, openPhotoReady, loadRanks, overlayObjectName, overlayFicheData, overlayHiddenTest, overlayEnds,
    overlayPoints, saveOverlay,
  });

  // Pour les essais depuis la console : window.mesures.app.click(yaw, pitch)
  window.mesures = {
    refresh, map, openPhoto, buildFiche, paginateFiche, photoAtOffset, importOverlay, thumbnail,
    get app() { return etat.app; }, get psv() { return etat.psv; }, get videoPlan() { return parcours.videoPlan; },
    overlayFile: (handle) => { etat.overlay.fichier = handle; },  // fichier de la couche remplacé (essais)
    // couche gardée (essais)
    savedOverlay: async () => {
      await etat.overlaySaving;
      return JSON.parse(await fileStore("readonly", (s) => s.get("couche-texte")) ?? "null");
    } };
})();
