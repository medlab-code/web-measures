// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Prise de mesure dans la visionneuse : bouton « Mesure », croix et traits des visées, réticule glissant, boutons
// d'étape (valider, garder, nouvelle mesure…), visées guidées (photos proposées), mode et réglages de la mesure.
// Sorti de la page (app.js) : Mesure.init s'exécute à la même place qu'avant.

import { Carte } from "./carte.js";
import { Couche } from "./couche.js";
import { Dessus } from "./dessus.js";
import { Traits } from "./traits.js";

const Mesure = {
  /** Branche la prise de mesure sur la page ; host : etat (état partagé) et fonctions de la page. Rend ce dont
   * la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      etat, showMapMeasureButton, viewer, stopPlayer, syncMapMeasure, updatePlayer, refresh, overlayAt, overlayHiddenTest,
      movingId, overlayPoints, viewHeading, openPhoto, notice, setPlacing, store, editReleve,
      escapeHtml,
    } = host;

    // Bouton « Mesure » ------------------------------------------------------------------------

    /**
     * La visionneuse montre-t-elle la photo dont le calcul a la fiche ? Pendant un changement de
     * photo, l'une ou l'autre est en retard : un clic mêlerait la direction d'une photo et la
     * position de l'autre (comme le plugin, on le refuse).
     */
    function photoReady() {
      if (!etat.psv || !etat.photo) return false;
      // Photo affichée (getPictureId donnerait celle en cours de chargement)
      const shown = etat.psv.getPictureMetadata?.()?.id;
      return shown === etat.photo.id;
    }
    const LOADING = "Photo en cours de chargement : cliquez à nouveau.";

    /**
     * Clics dans la photo pour viser (triangulation, point de référence d'une hauteur) : plusieurs
     * photos, flèches gardées. Suit l'état du calcul (voir refresh).
     */

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
    // .sur-droite : réticule tenu sur l'axe de la hauteur (slideOnGuide), qui remplace le pointeur
    const cursorCss = (tilted, calibrating, sighting) => `.psv-container, .psv-container * { cursor: url("data:image/svg+xml;utf8,${
      encodeURIComponent(reticle(reticleColor(tilted, calibrating, sighting)))}") 16 16, crosshair !important; }
      .psv-container .psv-virtual-tour-link, .psv-container .psv-virtual-tour-link * { cursor: pointer !important; }
      .psv-container.sur-droite, .psv-container.sur-droite * { cursor: none !important; }`;

    /** Flèches de navigation au sol (ellipse violette, triangle blanc) : masquées pendant une mesure (visée comprise, la photo
     * se change par le lecteur ou la carte) et pendant la largeur dans la visionneuse (bouton « Largeur dans la visionneuse » enfoncé, lu sans toucher à nez.js) ;
     * visibles hors mesure. Une seule décision : classe « sans-fleches » sur le conteneur (règle CSS posée par attachViewer). */
    function syncArrows() {
      const hidden = (etat.measuring && $("#mode").value !== "carte") || $("#nez-bords")?.getAttribute("aria-pressed") === "true";
      etat.psv?.container.classList.toggle("sans-fleches", hidden);
    }
    // La largeur dans la visionneuse change le bouton sans passer par applyMeasureUi : on suit son attribut
    const bords = $("#nez-bords");
    // et le lecteur de séquence (◀◀ ▶ ▶▶) est grisé tant que la largeur est active : la photo ne change plus
    if (bords) new MutationObserver(() => { syncArrows(); updatePlayer(); }).observe(bords, { attributes: true, attributeFilter: ["aria-pressed"] });

    // Boutons « mode + mesure » de la visionneuse : hauteur (↕), relevé d'objets et calage de l'inclinaison. Chacun met le mode voulu dans
    // la liste (cachée) Mode, puis lance la mesure (comme le bouton caché « Mesure ») ; déjà en mesure dans un autre mode, il change
    // seulement de mode ; enfoncé tant que la mesure est en cours dans son mode, un second clic l'arrête. Hauteur : même mesure que le
    // mode « Hauteur d'un objet » d'autrefois (option cachée, mode de départ du calcul).
    // Une seule fonction à la fois parmi hauteur, relevé, calage, profil en travers et largeur : « outil-visionneuse » annonce celle qui démarre.
    const modeButtons = [["#hauteur-visionneuse", "height", "hauteur"], ["#releve-visionneuse", "releve", "releve"],
      ["#calage-visionneuse", "tilt", "calage"]].map(([selector, mode, name]) => {
      const button = $(selector);
      const isOn = () => etat.measuring && $("#mode").value === mode;
      let was = false;
      const show = () => {
        const on = isOn();
        button.setAttribute("aria-pressed", String(on));
        button.classList.toggle("actif", on);
        button.disabled = !on && ($("#mesure").disabled || !etat.photo);  // comme « Mesure », et une photo à mesurer
        if (on && !was) document.dispatchEvent(new CustomEvent("outil-visionneuse", { detail: name }));
        was = on;
      };
      button.addEventListener("click", () => {
        if (!isOn()) {  // lance : le mode, puis la mesure (comme le bouton « Mesure »)
          if ($("#mode").value !== mode) {
            $("#mode").value = mode;
            $("#mode").dispatchEvent(new Event("change"));
          }
          if (!etat.measuring) $("#mesure").click();
          else show();
        } else {
          $("#mesure").click();  // arrête : comme le bouton « Mesure »
        }
      });
      document.addEventListener("outil-visionneuse", (event) => { if (isOn() && event.detail !== name) $("#mesure").click(); });
      return show;
    });
    // Largeur ↔ ou profil lancé pendant une mesure sans bouton dans la visionneuse (longueur ou surface sur la carte, mode « tri ») : la mesure
    // s'arrête aussi, sinon son réticule (vert une fois la photo calée) resterait sous la souris et le clic serait pris pour un point
    document.addEventListener("outil-visionneuse", (event) => {
      if (etat.measuring && ["largeur", "profil"].includes(event.detail) && !["height", "releve", "tilt"].includes($("#mode").value)) $("#mesure").click();
    });
    const showModeButtons = () => modeButtons.forEach((show) => show());
    new MutationObserver(showModeButtons).observe($("#mesure"), { attributes: true, attributeFilter: ["disabled"] });

    /** Navigation, flèches, curseur au sol et pointeur de la visionneuse selon le bouton « Mesure ». */
    function applyMeasureUi() {
      $("#mesure").setAttribute("aria-pressed", String(etat.measuring));
      $("#mesure").classList.toggle("actif", etat.measuring);
      showMapMeasureButton();
      const mode = $("#mode").value;
      // Longueur sur la carte : tout se fait sur la carte, pas d'aide dans la visionneuse
      $("#mode-mesure").hidden = !etat.measuring || mode === "carte";
      $("#entete-etape").hidden = mode === "carte";
      // Liseré autour de la visionneuse : bleu pendant les visées de triangulation, jaune pendant la
      // prise de mesure (couleurs de leurs croix)
      // longueur sur la carte : le cœur reste en mode « tri », sans visée
      const sighting = etat.measuring && etat.aiming && mode !== "carte";
      const taking = etat.measuring && !etat.aiming && ["height", "carte"].includes(mode);
      const calibrating = etat.measuring && mode === "tilt";
      $("#vue").classList.toggle("visee", sighting);
      $("#vue").classList.toggle("prise", taking);
      $("#vue").classList.toggle("calage", calibrating);
      // Largeur, hauteur, relevé : trait vertical au centre de la vue, le cap tracé sur la
      // carte ; la vue tournée vers le point à viser (take_aim_frame), il le désigne (ticket #26)
      $("#axe-vue").hidden = !etat.measuring || !["height", "releve"].includes(mode) || viewer.hidden;
      $("#croix-cadastre").hidden = !$("#cadastre").checked || !$("#cadastre-visionneuse").checked || viewer.hidden;
      // Même état en toutes lettres, sous le rappel du mode (comme les voyants)
      // Carte d'étape (en bas, en mesure) : nom de la mesure et ses étapes, la courante en couleur
      $("#vue").classList.toggle("en-mesure", etat.measuring && mode !== "carte");  // mesure sur la carte : la visionneuse reste libre
      const [title, steps, current] = mode === "height" ? ["Hauteur", ["Pied", "Sommet"], etat.aiming ? 0 : etat.newMeasure ? 2 : 1]
        : mode === "releve" ? ["Relevé d'objets", ["Objet visé", "Ses champs"], 0]
        : mode === "carte" ? Dessus.tool() === "surface" ? ["Surface sur la carte", ["Sommets", "Fermeture"], Dessus.hasStart() ? 1 : 0]
          : ["Longueur sur la carte", ["Départ", "Arrivée"], Dessus.hasStart() ? 1 : 0]
        : ["Calage de l'inclinaison", ["Deux objets verticaux"], 0];
      $("#nom-mesure").textContent = title;
      $("#etapes").replaceChildren(...steps.map((step, k) => Object.assign(document.createElement("li"), {
        textContent: step, className: k < current ? "faite" : k === current ? "courante" : "" })));
      const state = $("#etat-mesure");
      state.hidden = !sighting && !taking;
      state.className = sighting ? "visee" : taking ? "prise" : "";
      state.textContent = sighting ? "Triangulation en cours" : taking ? "Mesure en cours" : "";
      $("#mode-mesure").textContent = mode === "releve"
          ? "Relevé d'objets : visez l'objet depuis plusieurs photos puis « Valider le point triangulé », ou gardez-le sur une seule photo"
        : mode === "height" && etat.aiming
          ? "Hauteur, étape 1 : visez le pied depuis plusieurs photos (lecteur, carte), puis « Valider le point triangulé »"
        : mode === "height" && etat.newMeasure
          ? `Hauteur faite : cliquez une de ses croix pour l'ajuster ; autre hauteur : « Nouvelle mesure depuis ${etat.newMeasure} »`
        : mode === "height" ? "Hauteur, étape 2 : cliquez le sommet (le pied est le point visé) ; autre photo : par la carte"
        : mode === "carte" && Dessus.tool() === "surface"
          ? "Surface sur la carte : cliquez les sommets, puis le dernier (ou le premier) pour fermer ; Échap : tout retirer, Effacer : le dernier"
        : mode === "carte" ? `Longueur sur la carte : cliquez ${Dessus.hasStart() ? "l'arrivée" : "le départ"}, `
          + "de préférence sur la vue Bird Eye (allumée : avec incertitude), en face de la caméra ; Échap : retirer le départ"
        : mode === "tilt" ? "Calage de l'inclinaison : pied puis sommet de deux objets verticaux, à 90° l'un de l'autre"
        : "Mode mesure en cours : désélectionner pour naviguer";
      // Nom de la mesure et étape déjà dans l'en-tête de la carte d'étape (« Hauteur, étape 1 : »…) : retirés
      const MODE_NAMES = /^(?:Hauteur|Largeur|Relevé d'objets|Longueur sur la carte|Surface sur la carte|Calage de l'inclinaison)[^:]*: /;
      const tip = $("#mode-mesure").textContent.replace(MODE_NAMES, "");
      $("#mode-mesure").textContent = tip[0].toUpperCase() + tip.slice(1);
      showModeOptions();
      showModeButtons();
      const box = etat.psv?.container;
      if (!box) return;
      syncArrows();  // flèches au sol : masquées en mesure et en largeur dans la visionneuse
      // Curseur « aller ici » du moteur 360° : masqué par la règle CSS « sans-fleches » (syncArrows), comme les flèches au sol
      const root = box.getRootNode();
      let style = root.getElementById ? root.getElementById("mesure-pointeur") : null;
      // Mode « carte » (longueur, surface) : le réticule de mesure ne concerne que le curseur de la carte, jamais la visionneuse, où que soit la carte
      const onPhoto = etat.measuring && $("#mode").value !== "carte";
      if (onPhoto && !style) {
        style = Object.assign(document.createElement("style"), { id: "mesure-pointeur" });
        (root === document ? document.head : root).append(style);
      } else if (!onPhoto && style) {
        style.remove();
      }
      if (style?.isConnected) {
        const css = cursorCss(etat.tilted, calibrating, sighting);
        if (style.textContent !== css) style.textContent = css;
      }
    }

    $("#mesure").addEventListener("click", () => {
      etat.measuring = !etat.measuring;
      if (etat.measuring) stopPlayer();  // la mesure se fait sur une photo arrêtée
      syncMapMeasure();
      applyMeasureUi();
      if (etat.psv) updatePlayer();
      refresh(etat.app.set_active(etat.measuring));
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
      const markers = etat.psv?.getPlugin?.("markers");
      if (!markers) return;
      const id = `${MARK}parcelle`, parcel = parcelReady && $("#cadastre-visionneuse").checked ? Carte.aimedParcel() : null;
      const at = parcel && etat.app ? JSON.parse(etat.app.view_point(parcel.at[0], parcel.at[1], PARCEL_LABEL_UP)) : null;
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
    let measureShown = false;  // mesure (valeur en mètres) sur la photo affichée (drawViewerMarks)
    /** « Avec annotations » : actif dès qu'une annotation est dans la visionneuse (mesure, étiquette de la parcelle visée,
     * objet de la couche affichée). */
    function updateAnnotationsButton() {
      const parcel = (() => {
        try {
          return Boolean(etat.psv?.getPlugin?.("markers")?.getMarker(`${MARK}parcelle`));
        } catch {
          return false;
        }
      })();
      $("#vignette").disabled = $("#vignette").dataset.etat === "en-cours"  // capture en cours : pas relançable (fiche.js)
        || !etat.photo || !(measureShown || parcel || Traits.hasExtra() || markIds.some((id) => id.startsWith(`${MARK}couche-`)));
    }

    document.addEventListener("annotations-changed", updateAnnotationsButton);  // largeur dans la visionneuse tracée ou retirée

    function drawViewerMarks(marks) {
      etat.currentMarks = marks;
      etat.crossAt = etat.app ? JSON.parse(etat.app.pick_points()) : [];
      // « Avec annotations » : mesure (valeur en mètres) sur la photo affichée, parcelle visée, couche
      measureShown = marks.some((m) => !m.guide && /\d m\b/.test(m.label || ""));
      const markers = etat.psv?.getPlugin?.("markers");
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
        if (mark.trace) {  // verticale du panneau « Calage manuel » (src/calage.js) : trait de la couleur de son verdict, numéro à côté
          lines.push({ points: mark.points, color: mark.trace, width: mark.sel ? 5 : 2, dash: null });
          const mid = middle(points);
          labels.push({ at: [mid.yaw, mid.pitch], type: "mesure", place: "cote", text: mark.label });
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
          labels.push({ at: [mid.yaw, mid.pitch], type: "mesure", place: mark.beside ? "cote" : "dessus",
            text: measureLabel(mark, names) });
        }
      });
      // Couche importée : lignes et contours en traits de sa couleur, points en pastilles, étiquettes
      if (etat.overlay && etat.app && $("#couche-visible").checked) {
        let points = 0, n = 0, rank = 0;
        overlayAt.clear();
        const hidden = overlayHiddenTest();
        for (const o of JSON.parse(etat.app.overlay_marks())) {
          const p = etat.overlay.features[o.id]?.properties || {};
          if (hidden(etat.overlay.features[o.id])) continue;  // valeur masquée dans la légende, ou hors du filtre
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
      Traits.attach(etat.psv);
      Traits.set(lines, { crosses, labels });
      markers.renderMarkers?.();
      requestAnimationFrame(() => requestAnimationFrame(declutterLabels));  // une fois placées
    }

    /**
     * Étiquettes des points d'arrivée qui se chevauchent (sommets ou bords proches) : écartées
     * vers le bas, de la plus haute à la plus basse, l'ordre gardé ; un trait relie l'étiquette
     * écartée à sa croix. Les autres étiquettes (noms) restent en place et sont
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
     * Étiquette d'une mesure dans la photo, comme celle d'une longueur sur la carte : noms des
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

    // Visées guidées (hauteur, largeur) : photos proposées par le calcul ----------------------


    /**
     * Flèche d'une photo proposée, selon où elle se trouve par rapport au centre de la vue : ◀ ▶
     * sur le côté, ▲ devant, ▼ derrière (la précédente n'est pas toujours à gauche : en regardant
     * devant à droite, elle est derrière, légèrement à droite). "" si sa position est inconnue.
     */
    function guideArrow(choice) {
      const view = viewHeading();
      if (view == null || choice.lon == null || !etat.photo) return "";
      const [lon0, lat0] = etat.photo.geometry.coordinates;
      const x = (choice.lon - lon0) * Math.cos(lat0 * Math.PI / 180), y = choice.lat - lat0;
      const bearing = Math.atan2(x, y) * 180 / Math.PI;
      const off = ((bearing - view) % 360 + 540) % 360 - 180;  // -180 à 180 : gauche < 0 < droite
      if (Math.abs(off) < 30) return "▲";
      if (Math.abs(off) > 150) return "▼";
      return off < 0 ? "◀" : "▶";
    }

    function showGuide(guide) {
      etat.guideShown = guide;
      const box = $("#guide-photos");
      const choices = (etat.measuring && guide && guide.choices) || [];
      box.hidden = !choices.length || viewer.hidden;
      box.replaceChildren(...choices.map((choice) => {
        const arrow = guideArrow(choice);
        // Incertitude attendue du point avec cette visée en plus (voir App.guide)
        const m = (v) => v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const label = choice.expect == null ? choice.label
          : `${choice.label} · ±${m(choice.expect)} m`;
        const title = choice.expect == null ? choice.title
          : `${choice.title}. Incertitude attendue du point : `
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
      if (!etat.psv || !points || !points.length) return;
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      const yaw = Math.atan2(points.reduce((t, p) => t + Math.sin(p[0]), 0), points.reduce((t, p) => t + Math.cos(p[0]), 0));
      const pitches = points.map((p) => p[1]);
      const pitch = (Math.min(...pitches) + Math.max(...pitches)) / 2;
      const spreadYaw = 2 * Math.max(...points.map((p) => Math.abs(wrap(p[0] - yaw))));
      const spreadPitch = Math.max(...pitches) - Math.min(...pitches);
      const box = etat.psv.container, aspect = box.clientWidth / Math.max(box.clientHeight, 1);
      // Champ vertical : la largeur avec une marge (au plus le champ maximal de la visionneuse :
      // une largeur vue de très près peut ne pas tenir entière), ou 35° pour un point seul
      const deg = (r) => r * 180 / Math.PI;
      const maxFov = etat.psv.config?.maxFov || 90;
      const vfov = crop  // la mesure entière dans l'image recadrée au centre de la vue, avec sa marge
        ? Math.min(maxFov, Math.max(2, deg(spreadPitch) * crop.margin, deg(spreadYaw) * crop.margin / crop.aspect)
          * Math.max(1, crop.aspect / aspect))
        : Math.min(maxFov, Math.max(points.length > 1 ? 20 : 35, deg(spreadPitch) * 1.3, deg(spreadYaw) * 1.3 / aspect));
      const zoom = etat.psv.dataHelper?.fovToZoomLevel ? etat.psv.dataHelper.fovToZoomLevel(vfov) : undefined;
      etat.psv.animate({ yaw, pitch, ...(zoom == null || keepZoom ? {} : { zoom }), speed: 1200 });
    }

    /** Photo d'identifiant id ouverte, chargée et ses repères dessinés (fiche, mesure revue) ; 30 s au plus. */
    async function openPhotoReady(id) {
      await goToPhoto(id);
      const t0 = Date.now();
      while (etat.psv?.getPictureMetadata?.()?.id !== id || !photoReady()) {
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
      $("#nouvelle-reference").hidden = !etat.measuring || mode !== "height" || etat.aiming || viewer.hidden;
      // « Valider le point triangulé », dans la visionneuse : dès que les visées donnent un point
      $("#garder").hidden = !etat.measuring || !etat.aiming || !etat.pointReady || viewer.hidden;
      // Relevé, une seule visée : la question, avec la précision ; sinon viser depuis une autre photo
      $("#garder-seul").hidden = !etat.measuring || mode !== "releve" || etat.singleM == null || viewer.hidden;
      if (etat.singleM != null)
        $("#garder-seul").textContent = `✔ Garder sur cette seule photo (± ${String(etat.singleM).replace(".", ",")} m)`;
      $("#valider-objet").hidden = !etat.measuring || !etat.tiltReady || viewer.hidden;
      $("#nouvelle-mesure").hidden = !etat.measuring || !etat.newMeasure || viewer.hidden;
      $("#placer-carte").hidden = !etat.measuring || mode !== "releve" || viewer.hidden;
      if (etat.placing && $("#placer-carte").hidden) setPlacing(false);  // mesure arrêtée, autre mode
      $("#nouvelle-mesure").textContent = `↺ Nouvelle mesure depuis ${etat.newMeasure || "A"}`;
    }

    $("#mode").addEventListener("change", (event) => {
      syncMapMeasure();
      applyMeasureUi();  // triangulation : navigation rétablie
      if (etat.psv) updatePlayer();  // lecteur libre en mode carte
      refresh(etat.app.set_mode(event.target.value));
    });
    function setCamera() {
      const value = Number($("#camera").value);
      if (value >= 0.3 && value <= 6) {
        store.set("camera", $("#camera").value);
        refresh(etat.app.set_camera_height(value));
      }
    }
    $("#camera").addEventListener("change", setCamera);
    $("#camera-gps").addEventListener("click", (event) => {
      $("#camera").value = Number(event.target.dataset.value).toFixed(2);
      setCamera();
    });
    $("#valider-objet").addEventListener("click", () => refresh(etat.app.validate_tilt()));
    $("#garder").addEventListener("click", () => {
      const before = etat.app.has_releve() ? etat.app.releve_json() : "";
      refresh(etat.app.keep_point());
      const reference = etat.app.take_goto();  // retour sur la photo de référence, pour la mesure
      if (reference) goToPhoto(reference);
      if ($("#mode").value === "releve" && etat.app.releve_json() !== before) editReleve(null, true);
    });
    $("#garder-seul").addEventListener("click", () => {
      refresh(etat.app.keep_single());
      editReleve(null, true);
    });
    $("#nouvelle-mesure").addEventListener("click", () => refresh(etat.app.new_measure()));
    $("#nouvelle-reference").addEventListener("click", () => refresh(etat.app.new_reference()));
    $("#effacer").addEventListener("click", () => {  // comme Ctrl+Z : le dernier geste (onUndoKey)
      if (Dessus.cancelStart(false)) {
        refresh();
        return applyMeasureUi();
      }
      refresh(etat.app.undo());
    });
    $("#refaire").addEventListener("click", () => {  // comme Ctrl+Y : ce que le dernier « Effacer » a retiré
      refresh(etat.app.redo());
    });
    $("#tout-effacer").addEventListener("click", () => refresh(etat.app.clear_all()));
    new MutationObserver(showModeOptions).observe(viewer, { attributes: true, attributeFilter: ["hidden"] });

    return {
      applyMeasureUi, showParcelMark, showModeOptions, showGuide, photoReady, frameView, drawViewerMarks,
      openPhotoReady, reticleColor, onArrow, LOADING, scheduleDeclutter, waitParcelTiles, goToPhoto,
    };
  },
};

export { Mesure };
