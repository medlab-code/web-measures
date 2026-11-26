// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Choix de la photo sur la carte (clic, photo la plus proche, survol), photo affichée et son filaire, carte
// détachée dans une fenêtre, droite de mesure et longueur tracées sur la carte, objets de la couche recalés ou posés,
// mesures exportées revues sur leur photo. Sorti de la page (app.js) : Choix.init s'exécute à la même place.

const Choix = {
  /** Branche le choix de la photo sur la page ; host : etat (état partagé), fonctions de la page, et noms
   * déclarés plus bas (lus à chaque appel). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      map, setStatus, etat, refresh, showPhotoInfo, passesFilter, filterActive, viewer, notice, showOverViewer,
      setSwapped, mapBox, setFolded, grip, swapButton, measureButton, captureButton,
      exportButton, store, showFavorites, photoProducer, updateProducers, checkFarFromMeasures, showPlace, nez, showMapMeasureButton,
    } = host;

    // Choix de la photo sur la carte ---------------------------------------------------------

    map.on("click", (event) => {
      // Clic sur le trait de la zone du point d'intérêt (hors tracé) : zone retirée
      if (!host.parcours.travelPick && host.poi.zone && map.getLayer(host.ZONE_ID) && map.queryRenderedFeatures(
        [[event.point.x - 6, event.point.y - 6], [event.point.x + 6, event.point.y + 6]], { layers: [host.ZONE_ID] }).length) {
        host.poi.zone = null;
        host.showPoiZone();
        setStatus("Zone de l'effet retirée : 150 m avant et après le passage au plus près de la cible.");
        host.updatePlayer();
        return;
      }
      if (etat.measuring && $("#mode").value === "carte") {  // mesure sur la carte : jamais d'autre photo ouverte d'un clic
        const done = Dessus.addPoint(event.lngLat);
        if (done?.kind === "surface") refresh(etat.app.add_map_area(JSON.stringify(done.ring)));
        else if (done) refresh(etat.app.add_map_length(done.a[0], done.a[1], done.b[0], done.b[1], done.length, done.error, done.photos));
        else refresh();  // Effacer : le départ se retire
        host.applyMeasureUi();
      } else if (etat.placing) placeOnMap(event.lngLat);
      else if (etat.addingObject) host.addObjectAt(event.lngLat);
      else if (host.parcours.travelPick) host.pickTravelPoint(event.lngLat);
      else {
        // Mesure exportée de la couche sous le clic : revue sur sa photo ; sinon la photo la plus proche
        const { x, y } = event.point, layers = ["couche-traits", "couche-points"].filter((l) => map.getLayer(l));
        const hit = etat.overlay && !etat.measuring && layers.length
          ? map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers })
          .find((f) => etat.overlay.features[f.id]?.properties.photo_ref) : null;
        if (hit) reviewMeasure(hit.id);
        else openNearest(event.lngLat.lng, event.lngLat.lat);
      }
    });

    // Relevé : « Placer sur la carte », puis un clic sur la carte pose l'objet là (sans visée) ; Échap annule
    function setPlacing(on) {
      etat.placing = on;
      map.getCanvas().style.cursor = on ? "crosshair" : "";
      $("#placer-carte").textContent = on ? "Annuler (Échap)" : "📍 Placer sur la carte";
      $("#placer-carte").setAttribute("aria-pressed", String(on));
      if (on) setStatus("Relevé : cliquez sur la mini-carte l'emplacement de l'objet (zoomez pour être précis) ; Échap pour annuler.");
    }
    function placeOnMap(lngLat) {
      setPlacing(false);
      refresh(etat.app.keep_map(lngLat.lng, lngLat.lat));
      host.editReleve(null, true);
    }
    $("#placer-carte").addEventListener("click", () => setPlacing(!etat.placing));

    function onLineEscape(event) {  // aussi dans la carte détachée (toggleMapWindow)
      if (event.key === "Escape" && Dessus.cancelStart()) host.applyMeasureUi();  // tracé d'une mesure sur la carte
      if (event.key === "Escape" && etat.placing) {
        setPlacing(false);
        refresh();
      }
      if (event.key === "Escape" && etat.addingObject) host.setAddingObject(false);
      if (event.key === "Escape" && host.parcours.travelPick) {
        host.poi.draft = null;  // tracé de la zone ou de la planète interrompu
        host.parcours.planetDraft = null;
        host.setTravelPick(null);
        host.showPoiZone();
        host.showPlanets();
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
            : etat.app ? `Aucune photo près de ce point avec le filtre (${etat.app.filter_text()}).`
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
      if (etat.measuring || !event.composedPath().some((el) => el.dataset?.objet !== undefined)) return;
      Object.assign(objectTip.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
      tipTimer = setTimeout(() => { objectTip.hidden = etat.measuring; }, 2000);
    });
    for (const type of ["pointerleave", "pointerdown", "wheel"]) viewer.addEventListener(type, hideTip);

    // Clic droit dans la visionneuse en mesure : sélection d'un point, pas de menu du navigateur
    viewer.addEventListener("contextmenu", (event) => {
      // hors mesure, sur un objet de la couche : sa fiche (attachViewer), pas de menu non plus
      if (etat.measuring || event.composedPath().some((el) => el.dataset?.objet !== undefined)) event.preventDefault();
    });

    // Point sélectionné déplacé de 1 cm par les flèches : largeur, le long de la droite de mesure,
    // dans le sens vu sur la photo (← →) ou en s'éloignant de la caméra (↑ ↓) ; hauteur, monté ou
    // descendu (↑ ↓). Entrée termine son calage.
    const NUDGE_KEYS = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down" };
    function onNudgeKey(event) {
      const direction = NUDGE_KEYS[event.key];
      if ((!direction && event.key !== "Enter") || !etat.app || !etat.measuring || !etat.pointSelected) return;
      if (event.target.closest?.("input, select, textarea, button")) return;  // champ ou bouton actif
      event.preventDefault();
      event.stopPropagation();
      refresh(direction ? etat.app.nudge_point(direction) : etat.app.finish_point());  // Entrée : calage terminé
    }
    document.addEventListener("keydown", onNudgeKey, true);

    /** Nom de l'objet n° id de la couche dans sa fiche : sa colonne id (ou nom), sinon son rang. */
    function overlayObjectName(id) {
      const p = etat.overlay.features[id].properties;
      return String(p.id ?? p.nom ?? id + 1);
    }

    /** Données de la fiche de l'objet n° id de la couche (voir buildFiche, ficheHtml) : ses attributs (sans
     * les colonnes techniques d'un relevé), sa position (premier sommet), la photo de son cadrage
     * automatique : celle de son recalage, sinon la photo affichée s'il y est dessiné, sinon la plus proche. */
    // own : sans la photo affichée (fiches de tous les objets : chacun sur sa photo, quelle que soit la photo affichée) ;
    // seq : la plus proche dans cette séquence seulement (sans recalage ni photo d'origine), à défaut la plus proche
    async function overlayFicheData(id, columns = null, own = false, seq = null) {
      const f = etat.overlay.features[id];
      let [lon, lat] = f.geometry.coordinates;
      while (Array.isArray(lon)) [lon, lat] = lon;  // ligne, polygone : premier sommet
      const inSeq = seq && (await Carte.nearestPhoto(map, lon, lat, (p) => p.collection === seq && passesFilter(p)).catch(() => null))?.id;
      const pic = inSeq || f.properties.photo_ref || Object.keys(f.recalages || {})[0]
        || (host.overlayAt.has(id) && !own ? etat.photo?.id : null)
        || (await Carte.nearestPhoto(map, lon, lat, passesFilter).catch(() => null))?.id || null;
      // Colonnes choisies, dans leur ordre (askFiche) ; texte ajouté après la valeur de l'étiquette repris ici
      const props = host.overlayProperties(f);
      const suffixes = Object.fromEntries(host.overlayLabels().filter((l) => l.column && l.suffix.trim()).reverse()
        .map((l) => [l.column, l.suffix.trim()]));  // même colonne aux deux : celui de la première
      const attributes = (columns || Object.keys(props).filter((c) => !(etat.overlay.techniques || []).includes(c))).map((c) => {
        const text = Couche.format(props[c]);
        return [c, text && suffixes[c] ? `${text} ${suffixes[c]}` : text];
      });
      return { name: overlayObjectName(id), lon, lat, attributes, rows: [], texts: [], photo: pic, kind: null,
        bounds: [[lon, lat], [lon, lat]] };
    }

    /** Mesure exportée (App._records : vue_ref) revue sur sa photo : ses repères tels que dessinés quand elle a
     * été prise ([[cap, élévation]] en radians), ou null (autre photo, autre objet). */
    function overlayView(id) {
      const p = etat.overlay.features[id]?.properties || {};
      if (!p.vue_ref || p.photo_ref !== etat.photo?.id) return null;
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
      const [dyaw, dpitch] = etat.overlay.features[o.id]?.recalages?.[etat.photo?.id]?.decalage || [0, 0];
      return { kind: o.kind, pts: o.points.map(([yaw, pitch]) => [yaw + dyaw, pitch + dpitch]) };
    }

    /** Mesure exportée n° id de la couche revue : sa photo ouverte, cadrée sur elle comme la fiche. */
    async function reviewMeasure(id) {
      const pic = etat.overlay.features[id]?.properties.photo_ref;
      if (!pic || etat.measuring) return;
      try {
        if (etat.photo?.id !== pic) await host.openPhotoReady(pic);
        host.frameView(overlayView(id));
      } catch (error) {
        notice(`Mesure : ${error.message}`);
      }
    }

    /** Repère de l'objet n° id de la couche dans la photo affichée, recalage compris : [[cap, élévation]], ou []. */
    function overlayEnds(id) {
      const view = overlayView(id);
      if (view) return view;
      const at = host.overlayAt.get(id);
      if (!at) return [];
      const [dyaw, dpitch] = etat.overlay.features[id].recalages?.[etat.photo?.id]?.decalage || [0, 0];
      return [[at.yaw + dyaw, at.pitch + dpitch]];
    }

    /** Objet id de la couche choisi pour être recalé dans la photo affichée. */
    function moveOverlayObject(id) {
      etat.moving = { id, photo: etat.photo.id };
      etat.objectCurrent = id;  // ses attributs et son statut dans le parcours
      host.showObjectState();
      document.activeElement?.blur?.();  // un bouton cliqué avant (« Exporter »…) ne reçoit pas l'Entrée
      setStatus("Objet de la couche : cliquez sa place dans la photo (le clic le pose et finit), ou flèches pour l'ajuster "
        + "puis Entrée ; Suppr le remet à sa place calculée. La carte n'est pas modifiée.");
      host.drawViewerMarks(etat.currentMarks);
    }

    /** Objet en cours de recalage posé en (yaw, pitch) : sa pastille ou son étiquette y vient. */
    function placeOverlayObject(yaw, pitch) {
      const at = host.overlayAt.get(etat.moving.id);
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
      if (!etat.overlay || etat.measuring || host.playing() || document.querySelector("dialog[open]")) return;
      const from = etat.photo ? etat.photo.geometry.coordinates : map.getCenter().toArray();
      const near = etat.overlay.features.flatMap((f) => Object.entries(f.recalages || {}))
        .filter(([, r]) => r.position).map(([id, r]) => ({ id, ...r, d: metresBetween(r.position, from) }))
        .filter((r) => !etat.photo || r.d < SAME_ROAD).sort((a, b) => a.d - b.d);
      const key = etat.photo?.collection || "";
      if (!near.length || declinedSequences.has(key)
        || (etat.photo && near.some((r) => r.id === etat.photo.id || r.sequence === etat.photo.collection))) return;
      const dialog = $("#alerte-recalage");
      dialog.querySelector("p").textContent = etat.photo
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
      const f = etat.overlay.features[etat.moving.id];
      if (shift) {
        f.recalages = { ...f.recalages, [etat.photo.id]: { decalage: shift, position: etat.photo.geometry.coordinates.slice(0, 2),
          sequence: etat.photo.collection } };
      }
      else if (f.recalages) {
        delete f.recalages[etat.photo.id];
        if (!Object.keys(f.recalages).length) delete f.recalages;
      }
      host.setOverlayChanged(true);  // à réenregistrer dans le fichier
      host.saveOverlay();
      host.showOverlayInfo();
      host.drawViewerMarks(etat.currentMarks);
    }

    // Objet en recalage : flèches de 0,05° (environ un pixel sans zoom), Entrée ou Échap : fini,
    // Suppr : remis à sa place calculée
    const SHIFT_STEP = 0.05 * Math.PI / 180;
    const SHIFT_KEYS = { ArrowLeft: [-SHIFT_STEP, 0], ArrowRight: [SHIFT_STEP, 0], ArrowUp: [0, SHIFT_STEP], ArrowDown: [0, -SHIFT_STEP] };
    function onOverlayKey(event) {
      const step = SHIFT_KEYS[event.key];
      if (host.movingId() === null || (!step && !["Enter", "Escape", "Delete"].includes(event.key))) return;
      if (event.target.closest?.("input, select, textarea")) return;  // les boutons, eux, n'y ont pas droit
      event.preventDefault();
      event.stopPropagation();
      if (step) {
        const [dyaw, dpitch] = etat.overlay.features[etat.moving.id].recalages?.[etat.photo.id]?.decalage || [0, 0];
        return setShift([dyaw + step[0], dpitch + step[1]]);
      }
      if (event.key === "Delete") setShift(null);
      endMoving();
    }
    /** Recalage fini (Entrée, Échap, Suppr, ou clic qui pose l'objet) : objet désélectionné. */
    function endMoving() {
      etat.moving = null;
      setStatus("");
      host.drawViewerMarks(etat.currentMarks);
    }
    document.addEventListener("keydown", onOverlayKey, true);

    // Ctrl+Z (⌘Z), comme le bouton « Effacer » : dernier geste de mesure annulé (visée, clic, mesure
    // en cours, dernier point) ; dans un champ de saisie, l'annulation du texte reste celle du navigateur
    // Ctrl+Y (Ctrl+Maj+Z, ⌘⇧Z) : rétablit ce que le dernier « Effacer » a retiré
    function onUndoKey(event) {
      const key = event.key.toLowerCase();
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !["z", "y"].includes(key)) return;
      if (!etat.app || !etat.measuring || event.target.closest?.("input, select, textarea")) return;
      event.preventDefault();
      if (key === "z" && !event.shiftKey && Dessus.cancelStart(false)) return host.applyMeasureUi();  // départ d'une longueur sur la carte
      refresh(key === "y" || event.shiftKey ? etat.app.redo() : etat.app.undo());
    }
    document.addEventListener("keydown", onUndoKey);

    // Carte détachable dans une fenêtre à part, à placer sur un second écran (Edge, Chrome :
    // fenêtre « image dans l'image » de document ; ailleurs, pas de bouton). La carte y est
    // déplacée telle quelle : elle suit la photo, les mesures et le cadrage sans synchronisation.
    // Fermer la fenêtre, ou le bouton « ⧉ » ou « Remettre la carte ici », la remet en place.

    const detachButton = document.createElement("button");

    async function toggleMapWindow() {
      setSwapped(false);  // carte et visionneuse échangées : remises en place d'abord
      if (etat.mapWindow) {
        etat.mapWindow.close();  // pagehide : carte remise en place
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
      etat.mapWindow = win;
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
        etat.mapWindow = null;
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
      measureButton.hidden = captureButton.hidden = exportButton.hidden = !detached && !etat.swapped;
      showMapMeasureButton();  // place du faucon
      detachButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';  // fenêtre à part (dessin des boutons de la visionneuse)
      detachButton.setAttribute("aria-label", "Carte dans une fenêtre à part");
      detachButton.title = detached ? "Remettre la carte dans la page"
        : "Détacher la carte dans une fenêtre à part (second écran)";
      detachButton.classList.toggle("actif", detached);
    }

    if ("documentPictureInPicture" in window) {
      detachButton.type = "button";
      detachButton.className = "detacher-carte";
      detachButton.addEventListener("click", toggleMapWindow);
      showDetached(false);
      map.addControl({  // même étiquette que le zoom et l'échange des vues (voir resultats.js)
        onAdd: () => {
          (map.getContainer().querySelector(".maplibregl-ctrl-top-left .maplibregl-ctrl-group") || Object.assign(document.createElement("div"),
            { className: "maplibregl-ctrl maplibregl-ctrl-group" })).append(detachButton);
          return Object.assign(document.createElement("div"), { hidden: true });
        },
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
      host.attachViewer();
    }

    /**
     * Ferme la photo affichée, qui n'est plus de l'instance ou ne passe plus le filtre choisis :
     * ses flèches mèneraient sinon aux photos voisines qu'ils écartent. Les résultats restent.
     */
    function closePhoto(message) {
      if (etat.measuring) $("#mesure").click();
      etat.photo = null;
      store.set("photo", "");
      store.set("photo-lieu", "");
      viewer.hidden = true;
      $("#invite").hidden = false;
      $("#producteur-photo").hidden = true;
      $("#capture-hd").disabled = true;
      $("#vignette").disabled = true;
      $("#plein-ecran").disabled = true;
      nez.update();
      if (document.fullscreenElement) document.exitFullscreen();  // plus de photo à montrer
      Carte.showView(map, null);
      showPhotoInfo(null, message);
    }

    /** Photo affichée encore de l'instance et dans le filtre choisis ? Sinon, fermée. */
    async function checkPhoto() {
      const shown = etat.photo;
      if (!shown) return;
      if (!passesFilter(shown)) {
        closePhoto(etat.app ? `Photo fermée : hors du filtre (${etat.app.filter_text()}).` : "Photo fermée : hors du filtre.");
        return;
      }
      try {
        const feature = await Carte.photoById(shown.id);  // cherchée dans l'instance choisie
        if (!feature && etat.photo === shown) closePhoto("Photo fermée : elle n'est pas dans l'instance choisie.");
      } catch (error) {
        console.warn("Instance de la photo non vérifiée :", error);
      }
    }

    // Lecture de la séquence : la carte suit le tracé des photos image par image, environ une photo
    // en retard, à une vitesse qui ne change que progressivement (une animation par photo, coupée
    // par la suivante, la faisait avancer par à-coups). Saisie à la main pendant la lecture : elle
    // n'est plus suivie jusqu'à la lecture suivante. Lieu et ortho-express attendent l'arrêt.
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
      if (!host.playing() || follow.held) {
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
      if (!follow.held && etat.photo && $("#centrer").checked) {
        map.easeTo({ center: etat.photo.geometry.coordinates, duration: 400 });
      }
    }

    map.on("dragstart", (event) => {  // carte saisie à la main pendant la lecture : plus suivie
      if (event.originalEvent && follow.frame) follow.held = true;
    });

    function setPhoto(feature, recenter) {
      etat.photo = feature;
      store.set("photo", feature.id);  // rouverte à la prochaine visite (voir reopenPhoto)
      store.set("photo-lieu", JSON.stringify(feature.geometry.coordinates.slice(0, 2)));  // carte ouverte là (app.js)
      showFavorites();  // étoile de la nouvelle photo
      // En bas à droite de la visionneuse : « 2025 – producteur » (année de la prise de vue)
      const producer = photoProducer(feature);
      const taken = (feature.properties?.datetime || "").slice(0, 4);
      $("#producteur-photo").textContent = [taken, producer].filter(Boolean).join(" – ");
      $("#producteur-photo").hidden = !producer && !taken;
      const moving = host.playing();
      clearTimeout(detailsTimer);
      if (moving) detailsTimer = setTimeout(() => { if (etat.photo === feature) photoDetails(feature); }, PLAYING_DETAILS_DELAY);
      else photoDetails(feature);
      const coords = feature.geometry.coordinates;
      Carte.showView(map, coords, host.coneHeading(), host.viewFov());
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
      Fiche.updateCaptureButton();  // « Avec annotations » : selon les annotations (updateAnnotationsButton)
      $("#plein-ecran").disabled = !document.fullscreenEnabled;
      if (etat.app) refresh(etat.app.set_picture(JSON.stringify(feature)));
      nez.update();  // largeur dans la visionneuse : bouton selon la photo 360°, droite refaite
      proposeRecaledPhoto();
      updateProducers();
      checkFarFromMeasures(coords);
    }

    /** Détails de la photo tirés des services : lieu, ortho-express de son année. */
    function photoDetails(feature) {
      // Ortho-express de l'année de la photo (ou la plus proche disponible), annoncée dans la liste
      const year = Number((feature.properties?.datetime || "").slice(0, 4));
      if (year) {
        Carte.setExpressYear(map, year, ...feature.geometry.coordinates).then((used) => {
          if (etat.photo !== feature) return;  // photo déjà quittée
          $("#fond option[value=express]").textContent = used == null ? "Ortho-express (aucune ici)"
            : `Ortho-express ${used}` + (used === year ? "" : ` (photo de ${year})`);
        });
      }
      showPlace(feature);
    }

    return {
      openNearest, checkPhoto, openPhoto, overlayObjectName, overlayFicheData, overlayEnds,
      proposeRecaledPhoto, reviewMeasure, endMoving, moveOverlayObject, placeOverlayObject, setPhoto, follow, metresBetween,
      overlayPoints, setPlacing,
    };
  },
};
