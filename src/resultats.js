// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Résultats des mesures (liste, fiches, ligne d'état de la carte), échange de la carte et de la visionneuse,
// boutons posés sur la carte : mesure de longueur, vue Bird Eye, capture et export géoréférencé.
// Sorti de la page (app.js) : Resultats.init s'exécute à la même place qu'avant.

const Resultats = {
  /** Branche les résultats et les boutons de la carte sur la page ; host : etat (état partagé), fonctions de la
   * page, et noms déclarés plus bas (lus à chaque appel). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      etat, refresh, askFiche, showOverViewer, map, mapBox, setColumnFolded, setFolded, fold, columnFold, notice,
    } = host;

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
      const done = Boolean(measured.length) && etat.exported === etat.app.export_geojson();
      $("#resultats-infos").textContent = parts.length ? `${parts.join(" · ")} · ${done ? "exportés" : "non exportés"}` : "Aucune mesure";
      $("#resultats-infos").classList.toggle("a-exporter", Boolean(measured.length) && !done);
      $("#resultats-vide").hidden = Boolean(list.length);
    }

    /** Point effacé au milieu d'une chaîne (A–B–C) : propose de mesurer la distance A–C. */
    function proposeDistance() {
      const proposal = JSON.parse(etat.app.take_proposal());
      if (!proposal) return;
      const [i, j, a, c] = proposal;
      const dialog = $("#proposer-distance");
      dialog.querySelector("h2 span").textContent = `${a}–${c}`;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => {
        if (dialog.returnValue === "oui") refresh(etat.app.link_points(i, j));
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
      if ($("#dessus").checked && etat.photo && birdeyeFor && birdeyeFor !== etat.photo.id) $("#dessus").checked = false;
      const pose = etat.app && etat.photo ? JSON.parse(etat.app.birdeye_pose()) : null, shown = pose && pose.pic === etat.photo.id;
      $("#dessus").disabled = !shown;
      const on = shown && $("#dessus").checked;
      if (etat.photo) Carte.showView(map, etat.photo.geometry.coordinates, host.coneHeading(), host.viewFov());  // cône retiré ou remis
      const inMap = (selector) => mapBox.querySelector(selector);  // réglages sur la carte, peut-être détachée
      for (const id of ["#dessus-fine", "#dessus-voisines", "#dessus-position", "#dessus-bords", "#dessus-sans-cache"])
        inMap(id).disabled = !on;
      if (!on) {  // allumée : selon la vue (Dessus)
        for (const id of ["#dessus-verticales", "#dessus-devers", "#dessus-tangage", "#dessus-tangage-force"]) inMap(id).disabled = true;
      }
      inMap("#dessus-reglages").hidden = !on;  // vue du dessus allumée seulement
      showMapMeasureButton();
      if (on && birdeyeAsked !== etat.photo.id) {
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
      Dessus.update(on ? etat.photo : null, on ? JSON.parse(etat.app.birdeye_pose()) : null, birdeyeNear);
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
    let userSwap = false, measureSwap = false;  // échange en cours ; demandé par le bouton ; par la mesure
    function setSwapped(on) {
      if (on === etat.swapped || (on && etat.mapWindow)) return;
      etat.swapped = on;
      swapButton.setAttribute("aria-pressed", String(on));
      // carte en grand ou détachée : mesure et Bird Eye d'un clic
      measureButton.hidden = birdeyeButton.hidden = captureButton.hidden = exportButton.hidden = !on && !etat.mapWindow;
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
    const swapButton = Object.assign(document.createElement("button"), { type: "button", className: "echanger-vues", textContent: "⇄" });
    swapButton.setAttribute("aria-pressed", "false");
    swapButton.title = "Échanger la carte et la visionneuse (place et taille)";
    swapButton.addEventListener("click", () => {
      userSwap = !etat.swapped;
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
      textContent: "📏 Mesurer sur la carte" });
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
          { href: url, download: `bird-eye-${(etat.photo?.id || "carte").slice(0, 8)}-${stamp}.png` }).click();
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
        place.append(measureButton, toolSelect, birdeyeButton, captureButton, exportButton);
        return place;
      },
      onRemove: () => {},
    }, "top-left");
    /** Bouton de la carte en grand : enfoncé pendant la mesure, grisé sans photo 360° (pas de vue du dessus). */
    function showMapMeasureButton() {
      const on = etat.measuring && $("#mode").value === "carte";
      measureButton.setAttribute("aria-pressed", String(on));
      measureButton.textContent = on ? "📏 Arrêter la mesure" : "📏 Mesurer sur la carte";
      measureButton.title = on ? "Arrêter la mesure sur la carte"
        : "Mesurer sur la carte (longueur ou surface), sur la vue Bird Eye si elle est allumée, sinon sur le fond de carte";
      measureButton.disabled = !on && $("#mode").disabled;
      toolSelect.hidden = !on || measureButton.hidden;
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

    return {
      setSwapped, wantSwap, updateBirdeye, showResults, proposeDistance, swapButton, measureButton, birdeyeButton,
      captureButton, exportButton, showMapMeasureButton, syncMapMeasure, showResultsInfo,
    };
  },
};
