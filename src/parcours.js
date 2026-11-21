// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Lecture de la séquence (en arrière, pause, en avant, 1x à 16x) et onglet « Vidéo » : parcours (départ, arrivée,
// étapes), effets posés sur la carte, point d'intérêt, parcours gardés, préparation et calcul de la vidéo.
// Sorti de la page (app.js) : Parcours.init s'exécute à la même place qu'avant.

const Parcours = {
  /** Branche la lecture et l'onglet « Vidéo » sur la page ; host : fonctions de la page, et son état courant
   * (psv, photo, app, measuring : lus à chaque appel). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      map, viewer, store, instance, follow, metresBetween, setStatus, refresh, showPane, fileInput, ask, passesFilter,
      filterActive, notice, applyFilter, addProducer, saveAs, exportName, download, showOverViewer,
    } = host;

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
    let planetDraft = null;  // premier clic du tronçon de petite planète en cours de tracé (LngLat ou null)
    let chainedPick = false;  // arrivée demandée d'elle-même après le départ : son 📍 la garde au lieu de l'annuler
    // Endroits posés pour la vidéo, par sorte (« roll ») : [{ lonlat, marker, end }] (repère sur la carte ; un clic dessus
    // le retire ; end : fin du tronçon de la petite planète, lonlat en étant le début) ; css : classe du repère,
    // label : nom, check : interrupteur de l'option, note : rappel à la pose
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
    // recherche des photos à venir ; planError : { key, text } de la dernière en échec
    let planTimer = null, planTimerKey = "", planError = null;
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
        const state = !videoFormats ? "test de l'encodeur en cours" : !encoder ? "pas disponible sur ce poste"
          : encoder === "materiel" ? "encodeur matériel" : "encodeur logiciel, plus lent";
        button.title = `${FORMAT_NAMES[format]}, ${height}p : ${state}${draft ? " (brouillon : toujours 960 × 540)" : ""}`;
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
      return Boolean(fast) || Boolean(host.psv?.isSequencePlaying?.());
    }

    function stopPlayer() {
      if (fast) {
        clearTimeout(fast.timer);
        fast = null;
        updatePlayer();
        refresh();  // hauteur de chute d'un pont : calculée hors lecture
      }
      if (host.psv?.isSequencePlaying?.()) host.psv.stopSequence();
    }

    const { sequenceApis } = Services;

    function play(back, k) {
      stopPlayer();
      follow.held = false;  // nouvelle lecture : la carte suit de nouveau
      backward = back;
      speed = k;
      const rank = Number(host.photo?.properties?.["geovisio:rank_in_collection"]);
      const apis = host.photo?.collection ? sequenceApis(host.photo) : [];
      if (k === 1 || !Number.isInteger(rank) || !apis.length) {
        if (k !== 1) console.warn("Lecture rapide impossible (rang ou instance de la photo inconnus) : 1x");
        speed = 1;
        host.psv.playSequence(back);
        return;
      }
      fast = { collection: host.photo.collection, apis, rank, step: back ? -k : k, id: host.photo.id, ids: new Map(), points: new Map(),
        timer: null };
      // Comme en 1x : la visionneuse se croit en lecture (shouldGoFast) et charge l'image SD sans transition, la HD
      // seulement à l'arrêt (stopSequence, appelé par stopPlayer : forceRefresh). ±2 et non ±1 : sa boucle 1x, arrêtée
      // pendant le chargement d'une photo, reste abonnée à « picture-loaded » et repartait avec ±1, en même temps que la
      // lecture rapide (pas de 1, ou lecture bloquée : essai navigateur, 16/11/2026) ; elle n'avance qu'à 1 ou -1
      host.psv._sequencePlaying = back ? -2 : 2;
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
            throw new Error(`Panoramax, photos de la séquence ${(run.collection || "").slice(0, 8)} : `
              + `HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
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
          const turn = (Number.isFinite(heading) ? angleBetween(heading, go) : 0)
            + (after ? angleBetween(go, Requeteur.bearing(p.coords, after)) : 0);
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
      const stations = stationsAlong(line);
      // Photos le long du tracé : recherches de ALONG_CHUNK m de demi-côté, tous les ALONG_CHUNK m (4 à la fois)
      const photosById = new Map(), centres = stations.filter((_, i) => i % Math.round(ALONG_CHUNK / ALONG_STEP) === 0);
      for (let i = 0; i < centres.length; i += 4) {
        setStatus(`Vidéo : photos le long de ${label} (${Math.round(100 * i / centres.length)} %)…`);
        if ($("#video-recherche")) $("#video-recherche").value = i / centres.length;
        const found = await Promise.all(centres.slice(i, i + 4).map((c) => Carte.photosNear(map, ...c.at,
          (f) => passesFilter(f) && Number.isInteger(rankOf(f)), ALONG_CHUNK + ALONG_NEAR, 1000).catch(() => [])));
        for (const f of found.flat()) photosById.set(f.id, f);
      }
      const options = candidates(stations, photosById);
      const chosen = chooseSequences(options);
      if (!chosen) return null;
      const { pointAt, projectNear } = alongLine(line);
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
        warning: switches
          ? "Le parcours passe d'une séquence à l'autre : les photos peuvent différer (date, lumière, sens de prise de vue)." : "" };
    }
    /** Points du tracé line ([lon, lat]) tous les ALONG_STEP m, avec le cap de la route : [{ at, heading }]. */
    function stationsAlong(line) {
      const stations = [];
      for (let k = 1, carry = 0; k < line.length; k++) {
        const a = line[k - 1], b = line[k], d = metresBetween(a, b);
        if (d < 0.01) continue;
        const heading = Requeteur.bearing(a, b);
        let s = carry;
        for (; s < d; s += ALONG_STEP) stations.push({ at: [a[0] + (b[0] - a[0]) * s / d, a[1] + (b[1] - a[1]) * s / d], heading });
        carry = s - d;  // reste jusqu'au pas suivant, sur le segment d'après
      }
      return stations;
    }

    /** Candidats de chaque pas : Map (« séquence|à rebours » -> { f, d, back }) de la photo la plus proche de chaque
     * séquence et sens, à ALONG_NEAR m et ALONG_ANGLE° près. Photos rangées par cases de CELL degrés (une vingtaine de
     * mètres) : chaque pas ne regarde que les cases voisines. */
    function candidates(stations, photosById) {
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
      return stations.map(({ at, heading }) => {
        const best = new Map();
        for (const f of around(at)) {
          const d = metresBetween(at, f.geometry.coordinates);
          const azimuth = Number(f.properties?.["view:azimuth"]);
          if (d > ALONG_NEAR || !Number.isFinite(azimuth)) continue;
          const back = angleBetween(azimuth, heading) < ALONG_ANGLE ? false
            : angleBetween(azimuth + 180, heading) < ALONG_ANGLE ? true : null;
          if (back == null) continue;
          const key = `${f.collection}|${back}`;
          if (!best.has(key) || d < best.get(key).d) best.set(key, { f, d, back });
        }
        return best;
      });
    }

    /** Séquence et sens retenus à chaque pas (clé de options[i], ou null pour un pas sans photo), par programmation
     * dynamique : coût le plus bas pour arriver à chaque pas sur chaque séquence et sens (voir planAlongLine), puis
     * remontée ; null si aucun pas n'a de photo. */
    function chooseSequences(options) {
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
      if (!cost.size) return null;  // aucun pas avec photo
      // Remontée : séquence et sens retenus à chaque pas
      let key = [...cost].sort((x, y) => x[1] - y[1])[0][0];
      const chosen = Array(options.length).fill(null);
      for (let i = options.length - 1; i >= 0; i--) {
        if (!from[i]) continue;
        chosen[i] = key;
        key = from[i].get(key);
      }
      return chosen;
    }

    /** Trajectoire virtuelle : le tracé lui-même (abscisse curviligne de ses sommets) ; pointAt(s) : point à l'abscisse s ;
     * projectNear(point, s0) : { d, s }, point le plus proche sur les segments à ± 50 m de s0. Chaque photo y est ramenée :
     * la vidéo avance et prend son cap le long de la route, sans recul, arrêt ni balayage aux changements de séquence
     * (photos de voies voisines, décalées de quelques mètres). */
    function alongLine(line) {
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
      return { pointAt, projectNear };
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
        const target = {
          start: "le départ", end: "l'arrivée", roll: "l'endroit du tonneau", stop: "l'endroit de l'arrêt",
          slow: "un point de ralentissement", waypoint: "une étape (sur une route photographiée)",
          planet: planetDraft ? "la fin de la petite planète" : "le début de la petite planète (le long de la route)",
          tour: "l'endroit du tour d'horizon",
          poiZone: poi.draft ? "la fin de la zone de l'effet" : "le début de la zone de l'effet (le long de la route)",
        }[which];
        setStatus(`Parcours : cliquez sur la mini-carte ${target} ; Échap pour annuler.`);
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
      setStatus(`Tracé : cliquez sur la mini-carte ${{ start: "le départ", end: "l'arrivée", waypoint: "une étape, si besoin" }[which]} ; `
        + "Échap pour terminer.");
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
        select.append(Object.assign(document.createElement("option"),
          { value: "parcours", textContent: `${poiKept.label} (parcours gardé)` }));
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
        map.addLayer({ id: PLANETS_ID, type: "line", source: PLANETS_ID,
          paint: { "line-color": "#283593", "line-width": 6, "line-opacity": 0.8 } });
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
    const routeSettings = () => [$("#video-mode"), $("#video-vitesse"), $("#video-photos"), $("#video-codec"), $("#video-definition"),
      ...travelPane.querySelectorAll(".options input")];
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
        producer: host.app && host.photo ? JSON.parse(host.app.producer()) : null,
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
        ...("producer" in r
          ? { producer: Array.isArray(r.producer) && r.producer.length === 2 && r.producer.every((v) => typeof v === "string")
          ? r.producer.map((v) => v.slice(0, 200)) : null } : {}),
      };
    }
    /** Parcours rouvert : plus aucune photo de son producteur à son départ ni à son arrivée (instance ou méta-catalogue
     * en cours) : filtre producteur retiré, le parcours se fait avec les photos qui restent. Réseau en échec : filtre gardé. */
    async function dropMissingProducer(r) {
      if (!r.producer) return;
      const fromProducer = (f) => (f.providers || f.properties?.providers || []).some((p) => p.id === r.producer[0]
        && p.roles?.includes("producer"));
      const near = await Promise.all([r.travel.start.point, r.travel.end.point].filter(Boolean)
        .map((p) => Carte.photosNear(map, ...p, fromProducer, TOUR_REACH))).catch(() => null);
      if (!near || near.some((found) => found.length) || openedRoute !== r.id || $("#producteur").value !== JSON.stringify(r.producer))
        return;
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
      setStatus(`Parcours « ${r.name} » rouvert : « 🎬 Préparer la vidéo » pour la calculer ; `
        + "modifié, « ☆ Enregistrer les modifications » le remplace.");
    }
    // Effets « communication » : pastille jaune sur le parcours gardé si l'un d'eux est activé, verte sinon
    // Modes de la vidéo : réglages de départ des options (avancées), appliqués au choix du mode et retouchables ensuite ;
    // la page s'ouvre en mode Présentation (cases cochées d'origine)
    const VIDEO_MODES = {
      brouillon: { help: "Vérifier vite le trajet : allure de la présentation, image 960 × 540, titre et compteur de vitesse.",
        on: ["video-brouillon", "video-compteur", "video-compteur-vitesse", "video-titre"],
        off: ["video-acceleration", "video-vmax-arp", "video-flou", "video-expo", "video-rampe"] },
      presentation: { help: "Vue rapide de l'itinéraire : vitesse selon les virages, compteurs PR et vitesse, "
        + "sans option coûteuse en calcul.",
        on: ["video-compteur", "video-compteur-vitesse", "video-titre"],
        off: ["video-brouillon", "video-acceleration", "video-vmax-arp", "video-flou", "video-expo", "video-rampe"] },
      revue: { help: "Vitesse fixe : compteurs PR et vitesse, accélération latérale et V max ARP. "
        + "Dévers lu sur le LiDAR HD, environ 1 min de plus.",
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
      const touched = modeTouched(name) ? " Réglages modifiés : cliquer sur le mode rétablit les siens." : "";
      $("#video-mode-aide").textContent = `${VIDEO_MODES[name]?.help || ""}${touched}`;
    };
    /** Option de la vidéo active ? Brouillon : seuls le titre, le compteur de vitesse et les variations de vitesse automatiques
     * restent (DRAFT_OFF). */
    const videoOption = (id) => $(id).checked && !$("#video-brouillon").checked;
    const DRAFT_OFF = [
      "#video-compteur", "#video-acceleration", "#video-vmax-arp", "#video-stabilisation", "#video-flou", "#video-expo",
      "#video-regard", "#regard-vitesse", "#video-interet", "#interet-cible", "#interet-vitesse", "#interet-zoom",
      "#interet-zoom-distance", "#interet-tonneau", "#video-tonneau", "#tonneau-duree", "#video-tour", "#tour-duree",
      "#tour-arret", "#video-planete", "#planete-tout", "#planete-transition", "#planete-tonneau", "#planete-rotation",
      "#arret-duree", "#video-arret"
    ];
    /** Réglages du mode Présentation pour Video (vitesses en m/s), ou null dans un autre mode. */
    function presOptions() {
      if ($("#video-mode").value === "revue") return null;
      return { vmax: Number($("#pres-vmax").value) / 3.6, vmin: Number($("#pres-vmin").value) / 3.6, turn: Number($("#pres-virage").value),
        fade: Number($("#pres-transition").value), stop: Number($("#arret-duree").value),
        stops: videoOption("#video-arret") ? placed.stop.points.map((p) => p.lonlat) : [],
        slows: $("#video-ralenti").checked ? placed.slow.points.map((p) => p.lonlat) : [],
        slow: Number($("#ralenti-vitesse").value) / 3.6 };
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
    const SLIDER_UNITS = [["pres-vmax", "km/h"], ["pres-virage", "°/s"], ["pres-vmin", "km/h"], ["pres-transition", "s"],
      ["arret-duree", "s"], ["ralenti-vitesse", "km/h"]];
    for (const [id, unit] of SLIDER_UNITS) {
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
          : e.tagName === "SELECT" ? e.selectedOptions[0]?.defaultSelected
            || (!e.selectedIndex && ![...e.options].some((o) => o.defaultSelected))
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
      showOverViewer(dialog);
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
    $("#mes-parcours-exporter").addEventListener("click", async () => download(routeFile(savedRoutes()),
      await exportName("parcours", "json"), "application/json"));
    $("#mes-parcours-importer").addEventListener("click", () => $("#mes-parcours-fichier").click());
    fileInput("#mes-parcours-fichier", importRoutes);
    /** Parcours lus d'un fichier (un seul, ou { parcours: [...] }), ajoutés à ceux gardés. */
    function importRoutes(read) {
      const list = (Array.isArray(read) ? read : Array.isArray(read?.parcours) ? read.parcours : [read]).map(cleanRoute).filter(Boolean);
      if (!list.length) return notice("Fichier de parcours illisible.");
      setSavedRoutes([...savedRoutes(), ...list]);
      notice(`${list.length} parcours importé${list.length > 1 ? "s" : ""}.`);
    }
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
    const planKey = () => JSON.stringify([travelFields.state(), placed.waypoint.points.map(placeOf), $("#depuis").value,
      instance.value, $("#producteur").value]);
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
          throw new Error(`départ et arrivée au même endroit (moins de ${TOUR_REACH} m) : `
            + "choisissez l'arrivée (📍 de l'arrivée, ou son PR)");
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
      const key = JSON.stringify([videoReady, searching, failed, plan && plan.photos.length, plan?.title,
        plan && plan.photos[0]?.id, plan?.switches]);
      if (key === bandeauKey) return;
      bandeauKey = key;
      for (const marker of seamMarkers) marker.remove();
      seamMarkers = [];
      box.hidden = !videoReady;
      box.className = "bandeau-video";
      const strong = (text) => Object.assign(document.createElement("strong"), { textContent: text });
      if (searching) {
        box.replaceChildren(strong("Recherche des photos le long du tracé…"),
          Object.assign(document.createElement("progress"),
            { id: "video-recherche", max: 1, ariaLabel: "Avancement de la recherche des photos" }),
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
            const see = Object.assign(document.createElement("button"), { type: "button", textContent: "Voir",
              title: "Centrer la carte sur ce changement de séquence" });
            see.addEventListener("click", () => map.easeTo({ center: seam.at, zoom: Math.max(map.getZoom(), 15) }));
            const where = seam.pr ? `PR ${seam.pr.n} ${seam.pr.m < 0 ? "-" : "+"} ${Math.abs(seam.pr.m)}` : "Hors PR";
            const li = document.createElement("li");
            li.append(see, ` ${where} : ${seam.before} puis ${seam.after}`);
            list.append(li);
            const element = Object.assign(document.createElement("div"), { className: "repere-requete raccord",
              title: `Changement de séquence : ${seam.before} puis ${seam.after}` });
            seamMarkers.push(new maplibregl.Marker({ element, anchor: "bottom" }).setLngLat(seam.at).addTo(map));
          }
          box.replaceChildren(strong(`${sequences} séquences : ${seams.length} changement${seams.length > 1 ? "s" : ""}`), facts, list,
            Object.assign(document.createElement("p"),
              { className: "aide", textContent: "Les photos peuvent différer (date, lumière, sens de prise de vue)." }));
        }
      }
    }
    /** Durée de la vidéo préparée, en secondes. */
    const videoSeconds = () => {
      const v = presOptions()?.vmax ?? Number($("#video-vitesse").value) / 3.6;  // Présentation : celle des lignes droites
      return Video.duration(videoPhotos(), v * 3.6, $("#video-rampe").checked,
        videoOption("#video-regard") ? videoPlan.junctions || [] : [], Number($("#regard-vitesse").value), poiOptions(),
        presOptions()) + tourStops();
    };
    const secondsText = (s) => (s < 60 ? `${Math.round(s)} s`
      : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);

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
            : `Calcul de la vidéo en cours : image ${pad(done, width)} / ${pad(total, width)} `
              + `(${pad(Math.round(100 * done / total), 3)} %)`;
          $("#video-info").textContent = text;
          $("#video-barre").value = done / total;
          setStatus(text, "avancement");
          $("#statut").style.setProperty("--avancement", `${(100 * done / total).toFixed(1)}%`);
        }, videoRun.signal, {
          blur: videoOption("#video-flou"), draft: $("#video-brouillon").checked, stabilize: videoOption("#video-stabilisation"),
          format: $("#video-codec").value, height: Number($("#video-definition").value), exposure: videoOption("#video-expo"),
          ramp: !presOptions() && $("#video-rampe").checked, presentation: presOptions(),
          counter: videoOption("#video-compteur"), speedometer: $("#video-compteur-vitesse").checked,
          lateral: videoOption("#video-acceleration"), arpSpeed: videoOption("#video-vmax-arp"),
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
        const text = `Vidéo enregistrée dans « ${save.fileName} » : `
          + `${made.width} × ${made.height}, ${format}, ${(size / 1e6).toFixed(1)} Mo, `
          + `${Math.round((Date.now() - t0) / 1000)} s de calcul.`
          + (!$("#video-brouillon").checked && format !== FORMAT_NAMES[$("#video-codec").value]
            ? ` ${FORMAT_NAMES[$("#video-codec").value]} refusé par l'encodeur du poste.` : "")
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
        const seconds = Math.floor(n / Video.FPS);
        label.textContent = `${Math.round(frameKmh(xs, n))} km/h · `
          + `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
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
      const seq = host.psv?.getPictureMetadata?.()?.sequence || {};
      const on = playing();
      const blocked = host.measuring || !host.photo;
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
        : videoPlan ? "🎬 Pas assez de photos" : planError ? "🎬 Vidéo impossible"
        : videoReady ? "🎬 Recherche des photos…" : "🎬 Tracez le parcours";
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
      for (const id of [
        "#video-vitesse", "#video-photos", "#video-flou", "#video-brouillon", "#video-stabilisation", "#video-expo",
        "#video-rampe", "#video-titre", "#video-compteur", "#video-compteur-vitesse", "#video-acceleration",
        "#video-vmax-arp", "#video-regard", "#video-tonneau", "#tonneau-duree", "#regard-vitesse", "#video-interet",
        "#interet-vitesse", "#interet-zoom", "#interet-zoom-distance", "#interet-tonneau", "#video-planete",
        "#planete-tout", "#planete-transition", "#planete-rotation", "#video-tour", "#tour-duree", "#tour-arret"
      ]) {
        $(id).disabled = Boolean(videoRun);
      }
      updateFormats();
      travelPane.querySelector('.sur-carte[data-cote="planet"]').disabled = $("#planete-tout").checked;  // rien à tracer
      $("#planete-tonneau").disabled = Boolean(videoRun) || !Number($("#planete-transition").value);
      $("#video-mode").disabled = Boolean(videoRun);
      // Présentation et Brouillon : vitesse et rampe remplacées par l'allure ; Revue : l'inverse ; tout figé pendant le calcul
      if (presOptions()) $("#video-vitesse").disabled = $("#video-rampe").disabled = true;
      for (const id of ["#pres-vmax", "#pres-virage", "#pres-vmin", "#pres-transition", "#arret-duree", "#video-arret",
        "#ralenti-vitesse", "#video-ralenti"]) {
        $(id).disabled = Boolean(videoRun) || !presOptions();
      }
      for (const which of ["stop", "slow"])
        travelPane.querySelector(`.sur-carte[data-cote="${which}"]`).disabled = Boolean(videoRun) || !presOptions();
      if ($("#video-brouillon").checked) {
        for (const id of DRAFT_OFF) $(id).disabled = true;
        for (const which of ["stop", "roll", "tour", "planet"])
          travelPane.querySelector(`.sur-carte[data-cote="${which}"]`).disabled = true;
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
      host.psv.addEventListener("sequence-playing", (event) => {
        backward = Boolean(event.detail?.backward);
        updatePlayer();
      });
      host.psv.addEventListener("sequence-stopped", () => {
        updatePlayer();
        refresh();  // hauteur de chute d'un pont : calculée hors lecture
      });
      host.psv.addEventListener("picture-loaded", (event) => {
        // Lecture rapide : photo demandée affichée, la suivante après la durée de transition de
        // la visionneuse (comme sa lecture 1x)
        if (fast && event.detail?.picId === fast.id) {
          const run = fast;
          run.timer = setTimeout(() => {
            if (run === fast) fastStep(run);
          }, host.psv.getTransitionDuration?.() ?? 250);
        }
        updatePlayer();
      });
      host.psv.addEventListener("click", () => { if (fast) stopPlayer(); });  // comme la lecture 1x
      updatePlayer();
    }

    return {
      updatePlayer, stopPlayer, playing, attachPlayer, loadRanks, savedRoutes, importRoutes, poi, ZONE_ID, showPoiZone,
      showPlanets, setTravelPick, pickTravelPoint, refreshPoiTargets,
      get travelPick() { return travelPick; },
      get planetDraft() { return planetDraft; }, set planetDraft(value) { planetDraft = value; },
      get videoPlan() { return videoPlan; }, get poiTargets() { return poiTargets; },
    };
  },
};
