// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Résultats des mesures (liste, fiches, ligne d'état de la carte), échange de la carte et de la visionneuse,
// boutons posés sur la carte : mesure de longueur, vue Bird Eye, capture et export géoréférencé.
// Sorti de la page (app.js) : Resultats.init s'exécute à la même place qu'avant.

import { Attente } from "./attente.js";
import { Carte } from "./carte.js";
import { Dessus } from "./dessus.js";

const Resultats = {
  /** Branche les résultats et les boutons de la carte sur la page ; host : etat (état partagé), fonctions de la
   * page, et noms déclarés plus bas (lus à chaque appel). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      etat, refresh, askFiche, map, mapBox, setColumnFolded, setFolded, fold, columnFold, notice, nez,
    } = host;

    // Résultats ------------------------------------------------------------------------------

    let resultsKey = "";  // résultats affichés (sans les commentaires, que l'on est peut-être en train d'écrire)

    function showResults(list) {
      const key = JSON.stringify(list.map((r) => [r.kind, r.id, r.text, r.confiance]));
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
          etat.app.set_comment(r.kind, r.id, comment.value);
          clearTimeout(etat.saveTimer);
          etat.saveTimer = setTimeout(host.saveResults, 1000);
        });
        const remove = Object.assign(document.createElement("button"), {
          type: "button", className: "effacer-resultat", textContent: "×", title: "Effacer ce résultat",
        });
        remove.setAttribute("aria-label", `Effacer : ${r.text}`);
        remove.addEventListener("click", () => {
          refresh(etat.app.delete_result(r.kind, r.id));
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
          if (r.releve) return host.editReleve(r.id);
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
     * d'arrivée, valeur, incertitude) ; autre forme : le texte tel quel. */
    function resultLabel(r) {
      const span = (className, textContent) => Object.assign(document.createElement("span"), { className, textContent });
      const label = span("libelle", "");
      const point = r.kind === "point" && r.text.match(/^Point (\S+) (±.+)$/);
      const measure = r.kind === "mesure" && r.text.match(/^(\S+) ([A-Za-z]\S*) (\d.*?) (± .+)$/);
      if (point) label.append(span("puce-point", point[1]), span("valeur", "Point de référence"), span("incert", point[2]));
      else if (measure) label.append(span("symbole", measure[1]), span("puce-point fin", measure[2]), span("valeur", measure[3]),
        span("incert", measure[4]));
      else label.textContent = r.text;
      if (r.confiance) {  // inclinaison de la photo : confirmée, en désaccord ou non vérifiable (cœur : Calibration.confidence)
        const etat = r.confiance.includes("désaccord") ? "desaccord" : r.confiance.includes("confirmée") ? "confirmee" : "non-verifiable";
        label.append(span(`confiance ${etat}`, r.confiance));
      }
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
      const done = Boolean(measured.length) && etat.exported === etat.app.export_geojson();
      $("#resultats-infos").textContent = parts.length ? `${parts.join(" · ")} · ${done ? "exportés" : "non exportés"}` : "Aucune mesure";
      $("#resultats-infos").classList.toggle("a-exporter", Boolean(measured.length) && !done);
      $("#resultats-vide").hidden = Boolean(list.length);
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
    let calageFor = null;  // photo dont « Largeur dans la visionneuse » demande le calage Bird Eye, sans affichage (jusqu'à ce qu'il soit fait)
    function updateBirdeye() {
      if ($("#dessus").checked && etat.photo && birdeyeFor && birdeyeFor !== etat.photo.id) $("#dessus").checked = false;
      if (calageFor && calageFor !== etat.photo?.id) calageFor = null;  // autre photo : calage interrompu avec la vue
      if (calageFor && etat.app?.birdeye_impossible(calageFor)) {  // pose arrivée impossible : pas d'attente jusqu'à « trop long »
        const pic = calageFor;
        calageFor = null;
        nez.calibrated(pic, false);
      }
      const pose = etat.app && etat.photo ? JSON.parse(etat.app.birdeye_pose()) : null, shown = pose && pose.pic === etat.photo.id;
      $("#dessus").disabled = !shown;
      const on = shown && $("#dessus").checked;
      const silent = Boolean(shown && !on && calageFor);  // calage seul : les calculs de la vue, sans elle sur la carte
      if (etat.photo) Carte.showView(map, etat.photo.geometry.coordinates, host.coneHeading(), host.viewFov());  // cône retiré ou remis
      const inMap = (selector) => mapBox.querySelector(selector);  // réglages sur la carte, peut-être détachée
      for (const id of ["#dessus-fine", "#dessus-voisines", "#dessus-position", "#dessus-bords", "#dessus-sans-cache"])
        inMap(id).disabled = !on;
      if (!on) {  // allumée : selon la vue (Dessus)
        for (const id of ["#dessus-verticales", "#dessus-devers", "#dessus-tangage", "#dessus-tangage-force"]) inMap(id).disabled = true;
      }
      inMap("#dessus-reglages").hidden = !on;  // vue du dessus allumée seulement
      showMapMeasureButton();
      if ((on || silent) && birdeyeAsked !== etat.photo.id) {
        birdeyeAsked = etat.photo.id;
        birdeyeNear = null;
        etat.app.birdeye_neighbours("[]");
        etat.app.birdeye_far("[]");
        etat.app.birdeye_request();  // peut répondre tout de suite (déjà calée) : la pose est relue ensuite
      }
      // Voisines (« Véhicule masqué ») : fiches lues et inclinaison lancée seulement à la demande
      if (on && inMap("#dessus-voisines").checked && birdeyeNearAsked !== etat.photo.id) {
        birdeyeNearAsked = etat.photo.id;
        const feature = etat.photo;
        birdeyeNeighbours(feature).then(({ near, far }) => {
          if (etat.photo !== feature) return;
          birdeyeNear = [...near, ...far];
          etat.app.birdeye_far(JSON.stringify(far));
          etat.app.birdeye_neighbours(JSON.stringify(near));
          updateBirdeye();
        });
      }
      Dessus.update(on || silent ? etat.photo : null, on || silent ? JSON.parse(etat.app.birdeye_pose()) : null, birdeyeNear, silent);
    }
    // Calage Bird Eye demandé par « Largeur dans la visionneuse » (src/nez.js) : voir Nez.init (setCalage)
    nez.setCalage({
      /** { ok } si la photo est déjà calée (par la vue allumée ou par une demande précédente), undefined sinon. */
      state: (pic) => Dessus.calibrated(pic),
      /** Lance le calage ; faux si la photo affichée n'est plus celle demandée. Pose Bird Eye pas encore prête (photo tout juste
       * affichée, calcul en chargement) : le calage est gardé en attente et part dès que la pose arrive (refresh, updateBirdeye),
       * « Calage Bird Eye en cours… » restant affiché ; une photo dont la pose est impossible (pas 360°, ni cap, ni position :
       * App.birdeye_impossible) est refusée aussitôt (« impossible »), « trop long » restant le filet de src/nez.js. */
      start(pic) {
        if (!etat.app || etat.photo?.id !== pic || etat.app.birdeye_impossible(pic)) return false;
        calageFor = pic;
        updateBirdeye();  // sans pose prête : rien de lancé, repris à son arrivée
        return true;
      },
    });
    // Activation de la largeur ↔ : terrain et panorama de la photo lus à l'avance (en cache), sans lancer le calage, qui ne part
    // qu'au déplacement d'une poignée latérale
    document.addEventListener("outil-visionneuse", (event) => {
      if (event.detail !== "largeur" || !etat.app || !etat.photo) return;
      const pose = JSON.parse(etat.app.birdeye_pose());
      if (pose && pose.pic === etat.photo.id) Dessus.prefetch(etat.photo, pose);
    });
    Dessus.onCalibrated((pic, ok, final) => {
      if (final && calageFor === pic) {  // premier signal (final faux) : la largeur s'affiche, le raffinement du tangage continue
        calageFor = null;
        updateBirdeye();  // calage seul fini : la vue est mise de côté, rallumée plus tard sans rien refaire
      }
      nez.calibrated(pic, ok);
    });
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
    let userSwap = false, measureSwap = false;  // échange en cours ; demandé par le bouton ; par la mesure
    function setSwapped(on) {
      if (on === etat.swapped || (on && etat.mapWindow)) return;
      // Échange dans un sens ou l'autre : rien ne s'arrête (outils, mesures, Bird Eye, tracés) ; la photo et la carte se redessinent à leur
      // nouvelle taille (resize de la fenêtre, ResizeObserver de la carte).
      etat.swapped = on;
      swapButton.setAttribute("aria-pressed", String(on));
      // carte en grand ou détachée : mesure et Bird Eye d'un clic
      measureButton.hidden = exportButton.hidden = !on && !etat.mapWindow;  // faucon et capture : toujours là (showMapMeasureButton)
      showMapMeasureButton();  // outil de la mesure : avec le bouton
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
    const swapButton = Object.assign(document.createElement("button"), { type: "button", className: "echanger-vues",
      innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/></svg>', ariaLabel: "Échanger la carte et la visionneuse" });
    swapButton.setAttribute("aria-pressed", "false");
    swapButton.title = "Échanger la carte et la visionneuse (place et taille)";
    swapButton.addEventListener("click", () => {
      userSwap = !etat.swapped;
      if (!userSwap) measureSwap = false;  // remis en place à la main, même pendant la mesure
      wantSwap();
    });
    // Colonne de la carte en une seule étiquette : le bouton rejoint le groupe de MapLibre (sans boutons de zoom) (créé avant, par Carte.createMap) ;
    // le contrôle ajouté ne garde qu'un conteneur vide
    map.addControl({
      onAdd: () => {
        (map.getContainer().querySelector(".maplibregl-ctrl-top-left .maplibregl-ctrl-group") || Object.assign(document.createElement("div"),
          { className: "maplibregl-ctrl maplibregl-ctrl-group" })).append(swapButton);
        return Object.assign(document.createElement("div"), { hidden: true });
      },
      onRemove: () => {},
    }, "top-left");
    // Règle du bouton de mesure : même dessin que les boutons de la visionneuse (viewBox 24, trait 2, extrémités rondes), partagé avec l'attente (Attente)
    const RULER = Attente.icones.regle;
    // Carte en grand ou détachée : « Mesurer une longueur », sans passer par le mode du bandeau (même mesure que le mode « carte »)
    const measureButton = Object.assign(document.createElement("button"), { type: "button", className: "mesurer-carte", hidden: true,
      innerHTML: RULER + "<span>Mesurer sur la carte</span>" });
    // Outil du bouton : longueur ou surface (Dessus.setTool)
    const toolSelect = Object.assign(document.createElement("select"), { className: "outil-carte", hidden: true,
      title: "Outil de mesure sur la carte : longueur (deux clics) ou surface (contour, refermé en recliquant le dernier sommet)" });
    toolSelect.append(new Option("Longueur", "longueur"), new Option("Surface", "surface"));
    toolSelect.addEventListener("change", () => {
      Dessus.setTool(toolSelect.value);
      host.applyMeasureUi();
    });
    measureButton.setAttribute("aria-pressed", "false");
    measureButton.addEventListener("click", () => {
      const on = etat.measuring && $("#mode").value === "carte";
      if (on) return $("#mesure").click();  // arrêt, comme le bouton « Mesure »
      if ($("#mode").value !== "carte") {
        $("#mode").value = "carte";
        $("#mode").dispatchEvent(new Event("change"));
      }
      if (!etat.measuring) $("#mesure").click();
    });
    // Faucon : Bird Eye de la photo affichée, d'un clic (le même que l'interrupteur caché « #dessus ») ; une autre photo l'éteint (updateBirdeye)
    const birdeyeButton = Object.assign(document.createElement("button"), { type: "button", className: "birdeye-carte", hidden: true,
      ariaLabel: "Bird Eye" });
    birdeyeButton.innerHTML = Attente.icones.faucon;  // même dessin que l'attente de la vue du dessus (Attente)
    birdeyeButton.setAttribute("aria-pressed", "false");
    birdeyeButton.addEventListener("click", () => {
      $("#dessus").checked = !$("#dessus").checked;
      $("#dessus").dispatchEvent(new Event("change"));
    });
    const SIZED = (svg) => svg.replace("<svg ", '<svg width="24" height="24" ');  // taille des boutons de la carte
    // Capture de la carte entière telle qu'affichée (fond, filaire, mesures, vue Bird Eye si elle est allumée), sans les contrôles, téléchargée en PNG
    const captureButton = Object.assign(document.createElement("button"), { type: "button", className: "capture-carte", hidden: true,
      innerHTML: SIZED(Attente.icones.appareil),  // appareil photo, dessin partagé avec l'attente (Attente)
      title: "Capture de la carte entière en image PNG : fond, tracés, mesures et vue Bird Eye si elle est allumée, sans les boutons ni l'échelle", ariaLabel: "Capture de la carte" });
    // Attente au centre de la carte (petite, en grand ou détachée : son conteneur, Attente) tant que le fichier se prépare ; coche à la fin,
    // croix et message visible en cas d'échec
    captureButton.addEventListener("click", async () => {
      captureButton.disabled = true;
      const attente = Attente.start(map.getContainer(), { icone: Attente.icones.appareil, message: "Capture de la carte…" });
      try {
        const blob = await Carte.capture(map, { nue: true }), url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
        Object.assign(document.createElement("a"),
          { href: url, download: `carte-${etat.photo?.id || "sans-photo"}-${stamp}.png` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        attente.ok();
      } catch (error) {
        console.warn("Capture de la carte :", error);
        notice(`Capture de la carte impossible : ${error.message}`);
        attente.echec("Capture impossible");
      } finally {
        captureButton.disabled = false;
        showMapMeasureButton();
      }
    });
    // Export géoréférencé de la vue Bird Eye pour un SIG (GeoTIFF en Lambert 93) ; grisé Bird Eye éteinte
    const exportButton = Object.assign(document.createElement("button"), { type: "button", hidden: true, className: "capture-carte",
      // fichier dont le coin est replié, marqué « TIF » ; dessin partagé avec l'attente (Attente)
      innerHTML: SIZED(Attente.icones.tif),
      title: "Vue Bird Eye géoréférencée pour un SIG (QGIS…) : GeoTIFF en Lambert 93, la vue seule, sans fond de carte ni mesures",
      ariaLabel: "Export géoréférencé de la vue Bird Eye" });
    exportButton.addEventListener("click", async () => {
      exportButton.disabled = true;
      const attente = Attente.start(map.getContainer(), { icone: Attente.icones.tif, message: "Export GeoTIFF…" });
      try {
        const file = await Dessus.exportView();
        if (!file) {
          notice("Vue Bird Eye pas encore prête : export géoréférencé impossible pour l'instant.");
          attente.echec("Vue pas encore prête");
          return;
        }
        const url = URL.createObjectURL(file.blob);
        Object.assign(document.createElement("a"), { href: url, download: file.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        attente.ok();
      } catch (error) {
        console.warn("Export géoréférencé :", error);
        notice(`Export géoréférencé impossible : ${error.message}`);
        attente.echec("Export impossible");
      } finally {
        showMapMeasureButton();
      }
    });
    const placeBar = Object.assign(document.createElement("div"), { className: "maplibregl-ctrl place-mesurer" });
    // Annuler, refaire, tout effacer sur la carte en grand ou détachée (les mêmes fonctions que les boutons de la barre de la visionneuse, qui
    // ne sont plus sous la main) : les boutons de la barre sont cliqués, leur état grisé recopié. Dans l'étiquette de la mesure.
    const undoGroup = Object.assign(document.createElement("div"), { className: "mesure-annuler" });
    const undoButtons = [["#effacer", "Annuler le dernier geste de mesure (Ctrl+Z)"], ["#refaire", "Refaire (Ctrl+Y)"],
      ["#tout-effacer", "Tout effacer : mesures et points de la session"]].map(([id, title]) => {
      const source = $(id);
      const button = Object.assign(document.createElement("button"), { type: "button", hidden: true,
        innerHTML: source.innerHTML, title, ariaLabel: source.getAttribute("aria-label") });
      button.addEventListener("click", () => source.click());
      new MutationObserver(() => { button.disabled = source.disabled; }).observe(source, { attributes: true, attributeFilter: ["disabled"] });
      button.disabled = source.disabled;
      undoGroup.append(button);
      return button;
    });
    // Étiquette unique : mesure, outil, séparateur fin, annulation
    const measureLabel = Object.assign(document.createElement("div"), { className: "etiquette-mesure" });
    const toolGroup = document.createElement("div");  // seconde ligne quand la place manque : outil, séparateur, annulation
    toolGroup.append(toolSelect, Object.assign(document.createElement("span"), { className: "separateur" }), undoGroup);
    measureLabel.append(measureButton, toolGroup);
    placeBar.append(measureLabel, birdeyeButton, captureButton, exportButton);
    map.addControl({
      onAdd: () => placeBar,
      onRemove: () => {},
    }, "top-left");
    /** Place de l'étiquette de la mesure (carte en grand ou détachée), d'après les largeurs mesurées, sans seuil en dur. Dans l'ordre, le
     * premier qui tient : 1) rangée du haut, à gauche du filigrane de la carte (collé à la recherche), sur une ligne puis sur deux ;
     * 2) idem, le filigrane passé sous le requêteur (classe « filigrane-dessous » sur la carte) ; 3) rangée sous le requêteur (et le filigrane),
     * toute la largeur de la carte. Les boutons Bird Eye, capture et export suivent dans la même rangée, ou en dessous si la place manque
     * (retour à la ligne, rangée plafonnée à la place libre). Tout est recalculé à partir des largeurs naturelles (classes retirées d'abord) :
     * pas d'oscillation. */
    function placeMesure() {
      const container = map.getContainer(), search = container.querySelector(".recherche");
      const markNode = $("#filigrane-carte"), mark = markNode?.getClientRects().length ? markNode : null;  // masqué (carte détachée) : rien à contourner
      const request = container.querySelector(".requeteur");
      if (!search || !request || !measureLabel.getClientRects().length) return;  // carte à sa place, ou étiquette masquée : rien à placer
      container.classList.remove("filigrane-dessous");
      measureLabel.classList.remove("deux-lignes");
      placeBar.style.maxWidth = placeBar.style.top = "";
      const box = placeBar.getBoundingClientRect(), left = box.left, scale = box.width / (placeBar.offsetWidth || 1) || 1;
      const searchLeft = search.getBoundingClientRect().left, margin = 8 * scale;
      const markLeft = searchLeft - (mark ? mark.getBoundingClientRect().width + 6 * scale : 0);
      const one = measureLabel.getBoundingClientRect().width;
      measureLabel.classList.add("deux-lignes");
      const two = measureLabel.getBoundingClientRect().width;
      measureLabel.classList.remove("deux-lignes");
      // [filigrane dessous, largeur libre, ligne sous le requêteur] par configuration, dans l'ordre de préférence
      const configs = [[false, markLeft - left - margin, false], [true, searchLeft - left - margin, false],
        [true, container.getBoundingClientRect().right - left - 10 * scale, true]];
      let choice = configs.find(([, width]) => one <= width) || configs.find(([, width]) => two <= width) || configs[2];
      const [below, width, under] = choice;
      container.classList.toggle("filigrane-dessous", below);
      measureLabel.classList.toggle("deux-lignes", one > width);
      if (under) {
        const bottom = Math.max(request.getBoundingClientRect().bottom, mark ? mark.getBoundingClientRect().bottom : 0);
        placeBar.style.top = `${(bottom + 4 * scale - placeBar.getBoundingClientRect().top) / scale}px`;
      }
      placeBar.style.maxWidth = `${Math.max(width, 0) / scale}px`;
      placeReglages(container, request, mark, under);
    }
    /** Panneau des réglages Bird Eye : sous le requêteur, sous le filigrane s'il y est descendu et sous la barre de mesure quand elle est
     * en dessous ; hauteurs mesurées (pixels écran, ramenés à la carte), sans valeur en dur. La place restante borne sa hauteur (le CSS
     * lit --haut : défilement dans le panneau). */
    function placeReglages(container, request, mark, under) {
      const panel = container.querySelector("#dessus-reglages");
      if (!panel) return;
      const frame = container.getBoundingClientRect(), k = frame.width / (container.offsetWidth || 1) || 1;
      let bottom = request.getBoundingClientRect().bottom;
      if (mark && container.classList.contains("filigrane-dessous")) bottom = Math.max(bottom, mark.getBoundingClientRect().bottom);
      if (under) bottom = Math.max(bottom, placeBar.getBoundingClientRect().bottom);
      panel.style.setProperty("--haut", `${(bottom - frame.top + 8 * k) / k}px`);
    }
    new ResizeObserver(placeMesure).observe(map.getContainer());
    new ResizeObserver(placeMesure).observe(measureLabel);
    new ResizeObserver(placeMesure).observe(birdeyeButton);
    window.addEventListener("resize", placeMesure);

    /** Bouton de la carte en grand : enfoncé pendant la mesure, grisé sans photo 360° (pas de vue du dessus). */
    function showMapMeasureButton() {
      // Faucon : carte à sa place (à droite), au sommet de l'étiquette verticale (sans capture) ; carte en grand (à gauche) ou détachée, dans la
      // rangée de la mesure, entre l'outil et la capture, comme avant. Il change de place à chaque échange des vues.
      const column = map.getContainer().querySelector(".maplibregl-ctrl-top-left .maplibregl-ctrl-group");
      if (etat.swapped || etat.mapWindow) {
        if (captureButton.parentNode !== placeBar) placeBar.insertBefore(captureButton, exportButton);
        if (birdeyeButton.parentNode !== placeBar) placeBar.insertBefore(birdeyeButton, captureButton);
      } else if (column) {
        if (birdeyeButton.parentNode !== column || column.firstChild !== birdeyeButton) column.prepend(birdeyeButton);  // au sommet de la pile
        if (captureButton.parentNode === column) captureButton.remove();  // carte réduite : pas de capture (sans intérêt à cette taille)
      }
      captureButton.hidden = !(etat.swapped || etat.mapWindow);
      for (const button of undoButtons) button.hidden = !(etat.swapped || etat.mapWindow);  // carte à sa place : la barre de la visionneuse les a
      birdeyeButton.hidden = !(etat.swapped || etat.mapWindow) && !column;
      const on = etat.measuring && $("#mode").value === "carte";
      measureButton.setAttribute("aria-pressed", String(on));
      measureButton.innerHTML = `${RULER}<span>${on ? "Arrêter la mesure" : "Mesurer sur la carte"}</span>`;
      measureButton.title = on ? "Arrêter la mesure sur la carte"
        : "Mesurer sur la carte (longueur ou surface), sur la vue Bird Eye si elle est allumée, sinon sur le fond de carte";
      measureButton.disabled = !on && $("#mode").disabled;
      toolSelect.hidden = !on || measureButton.hidden;
      placeMesure();
      const bird = $("#dessus").checked;
      birdeyeButton.setAttribute("aria-pressed", String(bird));
      birdeyeButton.disabled = $("#dessus").disabled;
      exportButton.disabled = !bird || $("#dessus").disabled;  // rien de Bird Eye à exporter ; la capture, elle, marche toujours
      birdeyeButton.title = bird ? "Éteindre la vue Bird Eye"
        : "Vue Bird Eye de cette photo (calculée pour elle seule : une autre photo l'éteint)";
    }
    Dessus.setup(map, (on) => {
      measureSwap = on;
      wantSwap();
    });
    // Inclinaison de la photo tirée de la route par la vue du dessus (calage, curseurs) : reprise par la droite de « Largeur dans
    // la visionneuse », refaite si elle change (gardée par photo : une autre photo ne la reçoit pas)
    Dessus.onTilt((pic, tilt) => {
      if (etat.app?.birdeye_tilt_set(pic, tilt)) nez.changed();
    });

    /** Mode « Mesure sur la carte » : clics sur la carte en grand, tant que « Mesure » est enfoncé (Bird Eye s'allume à part). */
    function syncMapMeasure() {
      Dessus.setMeasuring(etat.measuring && $("#mode").value === "carte");
    }
    $("#dessus").addEventListener("change", (event) => {
      if (event.target.checked && etat.photo) map.jumpTo({ center: etat.photo.geometry.coordinates });  // le zoom ne bouge pas
      birdeyeFor = event.target.checked && etat.photo ? etat.photo.id : null;
      updateBirdeye();
    });
    mapBox.querySelector("#dessus-voisines").addEventListener("change", updateBirdeye);  // voisines à lire

    showMapMeasureButton();  // faucon à sa place de départ
    return {
      setSwapped, wantSwap, updateBirdeye, showResults, swapButton, measureButton, birdeyeButton,
      captureButton, exportButton, showMapMeasureButton, syncMapMeasure, showResultsInfo,
    };
  },
};

export { Resultats };
