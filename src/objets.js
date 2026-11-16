// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Couche importée dans la page : réglages (couleur, étiquette, légende, filtre), tableau des objets et leur statut,
// recalage dans la photo, objets ajoutés, couche gardée dans le navigateur, export (GeoJSON, CSV) et
// réenregistrement ; import commun de tous les fichiers (bouton ou glisser-déposer), rangés selon leur contenu.
// Lecture des fichiers : src/couche.js (Couche). Sorti de la page (app.js) : Objets.init s'exécute à la même place.

const Objets = {
  /** Branche la couche importée et l'import commun sur la page ; host : etat (état partagé), fonctions de la page,
   * et noms déclarés plus bas (lus à chaque appel). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      etat, setStatus, map, refresh, overlayObjectName, overlayFicheData, overlayEnds, notice, proposeRecaledPhoto, store,
      reviewMeasure, download, showOverViewer, askFiche, importFavorites,
    } = host;

    // Couche importée (GeoJSON) : une à la fois, couleur et étiquette selon une colonne ; gardée avec
    // ses réglages dans le navigateur d'une session à l'autre, jusqu'à « Retirer »
    // Colonnes de contrôle d'un objet relevé, sans intérêt pour la couleur ou l'étiquette (nb_visees reste :
    // qualité de la triangulation)
    const RELEVE_TECHNIQUES = ["angle", "incert_m", "ecart_m", "dist_max_m", "gps_m", "photos", "date_mesure", "z_ngf"];
    // Recalage d'un objet de la couche dans la photo affichée, la carte n'en est pas touchée : décalage
    // en cap et élévation (radians), feature.recalages[identifiant de photo] (Couche.read), gardé avec la
    // couche et dans son export GeoJSON
    const overlayAt = new Map();  // objet → position sans décalage de sa pastille ou de son étiquette
    const movingId = () => (etat.moving && !etat.measuring && etat.moving.photo === etat.photo?.id ? etat.moving.id : null);
    /** Clés des valeurs masquées de la colonne de couleur affichée (Couche.style : properties._cle). */
    function overlayMasked() {
      return new Set(etat.overlay?.masques?.[$("#couche-couleur").value] || []);
    }
    /** Test des objets cachés : valeur masquée dans la légende, ou hors du filtre par attribut (overlay.filtre :
     * { colonne, op, valeur }) ; (feature) → vrai si caché. */
    // Nombres comparés en nombres (virgule acceptée), sinon textes sans majuscules ; « ≠ » garde les objets sans valeur
    // (« verif ≠ vérifié » : ceux pas encore vus) ; =, ≠, <, > sans valeur saisie : filtre sans effet
    function overlayHiddenTest() {
      const masked = overlayMasked(), { colonne, op, valeur = "" } = etat.overlay?.filtre || {};
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
      const { colonne = "", op = "=", valeur = "" } = etat.overlay?.filtre || {};
      $("#couche-filtre").value = colonne;
      $("#couche-filtre-op").value = op;
      $("#couche-filtre-valeur").value = valeur;
      $("#couche-filtre-op").disabled = $("#couche-filtre-effacer").disabled = !colonne;
      $("#couche-filtre-valeur").disabled = !colonne || op === "vide" || op === "rempli";
    }
    function setOverlayFilter(filter) {
      etat.overlay.filtre = filter.colonne ? filter : null;
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
      if (!etat.overlay) return;
      const column = $("#couche-couleur").value;
      const custom = etat.overlay.couleurs[column] ||= {};
      for (const n of ["", "2"]) {  // sans étiquette, sans effet
        $(`#couche-intitule${n}`).disabled = $(`#couche-suffixe${n}`).disabled = !$(`#couche-etiquette${n}`).value;
      }
      const legend = Couche.style(etat.overlay.features, column, overlayLabels(), custom, $("#couche-etiquette-carte").value);
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
            const list = etat.overlay.masques[column] ||= [];
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
      const hidden = overlayHiddenTest(), shown = etat.overlay.features.filter((f) => !hidden(f));
      Carte.showOverlay(map, $("#couche-visible").checked ? { type: "FeatureCollection", features: shown } : null);
      $("#couche-filtre-bilan").hidden = !etat.overlay.filtre;
      $("#couche-filtre-bilan").textContent = `${shown.length} objet${shown.length > 1 ? "s" : ""} sur ${etat.overlay.features.length}`;
      refresh();
      showObjectTable();
    }

    /** Fiche de la couche : nombre d'objets, système de coordonnées, objets recalés dans des photos. */
    function showOverlayInfo() {
      const n = etat.overlay.features.length, k = etat.overlay.features.filter((f) => f.recalages).length;
      $("#couche-infos").textContent = [`${n} objet${n > 1 ? "s" : ""}`,
        etat.overlay.crs === "lambert93" ? "Lambert 93 converti" : "WGS 84", k ? `${k} recalé${k > 1 ? "s" : ""}` : ""]
        .filter(Boolean).join(" · ");
      $("#couche-fiches").textContent = `Fiches PDF des ${n} objet${n > 1 ? "s" : ""}`;
      $("#couche-fiches").disabled = !n;
    }

    // Parcours des objets de la couche : tableau trié (clic sur un intitulé) et filtré par la recherche ; ◀ ▶ dans son
    // ordre. Statut de vérification dans les colonnes « verif » et « verif_note » (10 lettres au plus : Shapefile), ajoutées
    // à la couche au premier statut, gardées et exportées comme ses autres colonnes.
    let objectSort = { key: "", up: true };  // "" : ordre du fichier
    let objectOrder = [];  // n° des objets du tableau, dans son ordre

    function showObjectTable() {
      if (!etat.overlay || !$("#couche-parcours").open) return showObjectState();
      const label = $("#couche-etiquette").value;
      const columns = [["", "Objet"], ...(label ? [[label, label]] : []), ["verif", "Statut"]];
      const value = (i, key) => (key ? Couche.format(etat.overlay.features[i].properties[key]) : overlayObjectName(i));
      const query = $("#objets-recherche").value.trim().toLowerCase();
      const hidden = overlayHiddenTest();
      objectOrder = etat.overlay.features.map((_, i) => i).filter((i) => !hidden(etat.overlay.features[i]))
        .filter((i) => !query || [overlayObjectName(i),
        ...Object.values(overlayProperties(etat.overlay.features[i])).map(Couche.format)].some((v) => v.toLowerCase().includes(query)));
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
        tr.setAttribute("aria-selected", String(i === etat.objectCurrent));
        tr.addEventListener("click", () => goToObject(i));
        return tr;
      }));
      showObjectState();
    }

    /** Objet du parcours, ◀ ▶, statut et commentaire : grisés tant qu'ils ne peuvent servir. */
    function showObjectState() {
      const k = objectOrder.indexOf(etat.objectCurrent), on = etat.overlay && etat.objectCurrent != null;
      $("#objet-precedent").disabled = !etat.overlay || k <= 0;
      $("#objet-suivant").disabled = !etat.overlay || !objectOrder.length || k === objectOrder.length - 1;
      $("#objet-statut").disabled = $("#objet-note").disabled = $("#objet-supprimer").disabled = !on;
      $("#objet-ajouter").disabled = !etat.overlay;
      showObjectAttributes();
      const p = on ? etat.overlay.features[etat.objectCurrent].properties : {};
      $("#objet-courant").textContent = on
        ? `Objet ${overlayObjectName(etat.objectCurrent)}${k >= 0 ? ` (${k + 1}/${objectOrder.length})` : ""}`
        : "Cliquez un objet du tableau, ou ▶";
      $("#objet-statut").value = p.verif || "";
      if (document.activeElement !== $("#objet-note")) $("#objet-note").value = p.verif_note || "";
      for (const tr of $("#objets-lignes").children)
        tr.setAttribute("aria-selected", String(objectOrder[tr.sectionRowIndex] === etat.objectCurrent));
    }

    /** Attributs de l'objet du parcours, modifiables (sans les colonnes techniques d'un relevé, ni statut et
     * commentaire) ; refaits seulement quand l'objet ou les colonnes changent (un champ en cours garde la main).
     * Colonne oui / non : case à cocher ; texte : valeurs des autres objets proposées (liste du navigateur, valeur
     * nouvelle possible) ; nombres : rien de proposé. */
    let attributesKey = "";
    function showObjectAttributes() {
      const on = etat.overlay && etat.objectCurrent != null;
      const columns = on
        ? etat.overlay.columns.filter((c) => !(etat.overlay.techniques || []).includes(c) && !["verif", "verif_note"].includes(c)) : [];
      const key = on ? `${etat.objectCurrent}|${columns.join("|")}` : "";
      if (key === attributesKey) return;
      attributesKey = key;
      const p = on ? etat.overlay.features[etat.objectCurrent].properties : {};
      $("#objet-attributs").replaceChildren(...columns.map((c, k) => {
        const label = Object.assign(document.createElement("label"), { textContent: c });
        const values = etat.overlay.features.map((f) => f.properties[c]).filter((v) => v != null && v !== "");
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
          input.addEventListener("focus", () => list.replaceChildren(...[...new Set(etat.overlay.features.map((f) => f.properties[c])
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
      const numeric = etat.overlay.features.some((f) => typeof f.properties[column] === "number");
      setObjectValue(column, !t ? null : numeric && Number.isFinite(n) ? n : t);
    }
    function setObjectValue(column, value) {
      etat.overlay.features[etat.objectCurrent].properties[column] = value;
      objectEdited();
    }

    /** Couche modifiée (attribut, statut ; geometry : objet ajouté ou supprimé, numéros refaits) : à réenregistrer. */
    function objectEdited(geometry = false) {
      if (geometry) {
        etat.overlay.features.forEach((f, i) => { f.id = i; });
        overlayAt.clear();
        attributesKey = "";
        etat.app.set_overlay(JSON.stringify(etat.overlay.features.map(({ id, geometry }) => ({ id, geometry }))));
        showOverlayInfo();
      }
      setOverlayChanged(true);  // à réenregistrer dans le fichier
      saveOverlay();
      showOverlayStyle();  // carte, photo, légende, tableau
    }

    $("#objet-supprimer").addEventListener("click", async () => {
      const i = etat.objectCurrent;
      if (await ask($("#supprimer-objet"), `L'objet ${overlayObjectName(i)} sera retiré de la couche. Le fichier ne change `
        + "qu'à l'enregistrement.") !== "supprimer" || etat.objectCurrent !== i) return;
      etat.overlay.features.splice(i, 1);
      etat.moving = null;
      etat.objectCurrent = null;
      objectEdited(true);
    });

    // Objet ajouté : un point posé d'un clic sur la mini-carte, attributs vides à saisir ; Échap annule
    function setAddingObject(on) {
      etat.addingObject = on;
      map.getCanvas().style.cursor = on ? "crosshair" : "";
      $("#objet-ajouter").textContent = on ? "Annuler (Échap)" : "＋ Ajouter un objet";
      $("#objet-ajouter").setAttribute("aria-pressed", String(on));
      if (on) setStatus("Couche : cliquez sur la mini-carte la place du nouvel objet (zoomez pour être précis) ; Échap pour annuler.");
    }
    function addObjectAt({ lng, lat }) {
      setAddingObject(false);
      const properties = Object.fromEntries(etat.overlay.columns.map((c) => [c, null]));
      // Colonne « id » (sans tenir compte de la casse) : le plus grand numéro existant + 1, dans la forme de la colonne
      // (nombre, ou texte de même largeur : « 007 » → « 008 ») ; aucun id numérique : laissée vide
      const idColumn = etat.overlay.columns.find((c) => c.toLowerCase() === "id");
      const ids = idColumn
        ? etat.overlay.features.map((f) => f.properties[idColumn]).filter((v) => /^\d+$/.test(String(v ?? "").trim())) : [];
      if (ids.length) {
        const top = ids.reduce((a, b) => (Number(b) > Number(a) ? b : a));
        const next = Number(top) + 1;
        properties[idColumn] = typeof top === "number" ? next : String(next).padStart(String(top).trim().length, "0");
      }
      etat.overlay.features.push({ type: "Feature", id: etat.overlay.features.length,
        geometry: { type: "Point", coordinates: [lng, lat] }, properties });
      objectEdited(true);
      setStatus("Objet ajouté à la couche : saisissez ses attributs sous le statut.");
      goToObject(etat.overlay.features.length - 1);
    }
    $("#objet-ajouter").addEventListener("click", () => setAddingObject(!etat.addingObject));

    /** Objet n° i de la couche : photo la plus proche (ou celle de son recalage) ouverte, tournée vers lui. */
    async function goToObject(i) {
      etat.objectCurrent = i;
      showObjectState();
      try {
        const data = await overlayFicheData(i, [], true);
        if (!data.photo) return setStatus("Aucune photo trouvée près de cet objet (filtre, instance ?).", "echec");
        if (etat.photo?.id !== data.photo) await host.openPhotoReady(data.photo);
        if (etat.objectCurrent !== i) return;  // un autre objet choisi entre-temps
        // Dessiné dans la photo une fois le sol lu (5 s au plus, puis à plat) ; masqué ou trop loin : tourné vers sa position
        await (async () => { for (let t = 0; t < 24 && !overlayEnds(i).length; t++) await new Promise((r) => setTimeout(r, 250)); })();
        const ends = overlayEnds(i), azimuth = Number(etat.photo.properties?.["view:azimuth"]);
        if (ends.length) host.frameView(ends);
        else if (Number.isFinite(azimuth)) {
          const [lon0, lat0] = etat.photo.geometry.coordinates;
          const bearing = Math.atan2((data.lon - lon0) * Math.cos(lat0 * Math.PI / 180), data.lat - lat0);
          etat.psv.animate({ yaw: bearing - azimuth * Math.PI / 180, pitch: 0, speed: 1200 });
        }
      } catch (error) {
        notice(`Objet ${overlayObjectName(i)} : ${error.message}`);
      }
    }

    /** Statut ou commentaire de l'objet du parcours ; la colonne est ajoutée à la couche à sa première valeur. */
    function setObjectCheck(column, text) {
      etat.overlay.features[etat.objectCurrent].properties[column] = text;
      if (text && !etat.overlay.columns.includes(column)) {
        etat.overlay.columns.push(column);
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
      const k = objectOrder.indexOf(etat.objectCurrent);
      goToObject(objectOrder[k < 0 ? 0 : k + step]);
    });

    /** Couche en place (lue d'un fichier, ou gardée) : calcul, réglages, carte ; cadrée dessus si fit. */
    // mapLabel : colonne de l'étiquette de la mini-carte ; null : « id » (sans tenir compte de la casse), sinon la première
    function loadOverlay(name, read, color = "", label = "", fit = false, visible = true, colors = {}, masks = {},
      mapLabel = null, label2 = "") {
      etat.overlay = { name, ...read, couleurs: colors, masques: masks };  // masques : { colonne: [clés de légende masquées] }
      // gardé (restoreOverlay)
      if (!etat.overlay.filtre?.colonne || !read.columns.includes(etat.overlay.filtre.colonne)) etat.overlay.filtre = null;
      etat.moving = null;  // couleurs choisies : { colonne: { clé de légende: couleur } }
      etat.objectCurrent = null;
      $("#couche-visible").checked = visible;
      const n = etat.app.set_overlay(JSON.stringify(read.features.map(({ id, geometry }) => ({ id, geometry }))));
      // Relevé (envoyé, ou réimporté) : colonnes techniques hors des listes, gardées dans les exports
      const technical = RELEVE_TECHNIQUES.every((c) => read.columns.includes(c)) ? RELEVE_TECHNIQUES : [];
      const choices = read.columns.filter((c) => !technical.includes(c));
      etat.overlay.techniques = technical;
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
      $("#couche-modele").disabled = Boolean(host.fieldsError(host.overlayFields()));
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
    const overlayWrite = (write, fallback) => {
      etat.overlaySaving = etat.overlaySaving.then(() => fileStore("readwrite", write)).then(() => {
        store.set("couche", "");  // ancienne place (versions d'avant IndexedDB) vidée
        return true;
      }, fallback);
      return etat.overlaySaving;
    };
    function saveOverlay() {
      if (!etat.overlay) return Promise.resolve(true);
      const text = JSON.stringify(overlaySaved());
      return overlayWrite((s) => s.put(text, "couche-texte"), () => store.set("couche", text));
    }
    /** Couche et ses réglages tels que gardés dans le navigateur (restoreOverlay, dossier de travail). */
    function overlaySaved() {
      const { name, features, columns, crs, couleurs, masques, fiche, filtre } = etat.overlay;
      return { name, columns, crs, couleurs, masques, fiche, filtre, couleur: $("#couche-couleur").value,
        etiquette: $("#couche-etiquette").value,
        intitule: $("#couche-intitule").checked, suffixe: $("#couche-suffixe").value, etiquetteCarte: $("#couche-etiquette-carte").value,
        etiquette2: $("#couche-etiquette2").value, intitule2: $("#couche-intitule2").checked, suffixe2: $("#couche-suffixe2").value,
        modifie: Boolean(etat.overlay.modifie), dateFichier: etat.overlay.dateFichier ?? null,
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
      if (etat.overlay) return;  // couche importée pendant la lecture : elle l'emporte
      let saved = null;  // sinon, ancienne place (localStorage), reprise une fois dans IndexedDB
      try { saved = JSON.parse(kept ?? (store.get("couche") || "null")); } catch { /* illisible : aucune */ }
      if (!applySavedOverlay(saved)) return;
      if (kept == null) saveOverlay();
      const restored = etat.overlay;  // fichier de la couche (Chrome, Edge), relu de façon asynchrone
      fileStore("readonly", (s) => s.get("couche")).then((handle) => {
        if (etat.overlay === restored && handle?.name === restored.name) restored.fichier = handle;
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
        else if (kind === "parcours") host.importRoutes(data);
        else if (kind === "modeles") host.importModels(data, file.name);
        else if (kind === "calage") host.importCalibration(text);
        else if (kind === "favoris") importFavorites(data);
        else if (kind === "dossier") await host.importFolder(data, file.name);
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
      if (d?.format === host.DOSSIER_FORMAT) return "dossier";
      if (d?.format === "parcours-panoramax" || (d && !Array.isArray(d) && d.travel)
        || (Array.isArray(d) && d.length && d.every((r) => r?.travel))) return "parcours";
      if (d?.format === host.MODELES_FORMAT) return "modeles";
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
      if (!files.length || !etat.app) return;
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
      etat.overlay.couleurs[$("#couche-couleur").value] = {};
      showOverlayStyle();
      saveOverlay();
    });
    const overlayProperties = (f) => Object.fromEntries(Object.entries(f.properties).filter(([k]) => !k.startsWith("_")));
    const overlayBaseName = () => etat.overlay.name.replace(/\.(geojson|json|zip|shp|gpkg|csv|txt)\b.*$/i,
      "").replace(/[\\/:*?"<>|]/g, "-");
    /** La couche en GeoJSON (WGS 84), recalages dans les photos compris. */
    const overlayGeojson = () => JSON.stringify({ type: "FeatureCollection",
      features: etat.overlay.features.map((f) => ({ type: "Feature", geometry: f.geometry, recalages: f.recalages,
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
      etat.overlay.fichier = handle;
      etat.overlay.dateFichier = handle ? date : null;
      fileStore("readwrite", (s) => (handle ? s.put(handle, "couche") : s.delete("couche"))).catch(() => null);
    }
    function setOverlayChanged(changed) {
      etat.overlay.modifie = changed;
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
        const handle = etat.overlay.fichier;
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
          const choice = !file ? "sous" : etat.overlay.dateFichier == null || date === etat.overlay.dateFichier ? "ecraser"
            : await ask($("#fichier-change"), `Le fichier « ${handle.name} » a été modifié le ${new Date(date).toLocaleString("fr-FR")}, `
              + "après son import ou son dernier enregistrement ici. L'écraser avec la couche affichée ?");
          if (!choice) return;
          if (choice === "ecraser") {
            await write(handle);
            etat.overlay.dateFichier = (await handle.getFile()).lastModified;
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
          etat.overlay.name = target.name;
          $("#couche-nom").textContent = target.name;
        } else if (!(await download(content, `${overlayBaseName()}.geojson`, "application/geo+json"))) return;
        setOverlayChanged(false);
        saveOverlay();
        setStatus(`Couche enregistrée${window.showSaveFilePicker ? ` dans « ${etat.overlay.name} »` : ""}.`);
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
      const points = etat.overlay.features.every((f) => f.geometry.type === "Point");
      const rows = [[...etat.overlay.columns, ...(points ? ["lon", "lat"] : ["wkt"])].map(cell).join(";"),
        ...etat.overlay.features.map((f) => [...etat.overlay.columns.map((c) => f.properties[c]),
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
      etat.overlay = null;
      etat.moving = null;
      etat.objectCurrent = null;
      objectOrder = [];
      setAddingObject(false);
      showObjectState();
      overlayWrite((s) => s.delete("couche-texte"), () => store.set("couche", ""));
      etat.app?.set_overlay("[]");
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

    // champ du bouton « Importer » des favoris (src/favoris.js) : fichier rangé par l'import commun
    fileInput("#favoris-fichier", importFavorites);

    return {
      restoreOverlay, addObjectAt, setAddingObject, overlayAt, overlayProperties, overlayLabels, showObjectState,
      setOverlayChanged, saveOverlay, showOverlayInfo, movingId, fileInput, ask, overlayHiddenTest,
      exportOverlay, loadOverlay, setOverlayFile, overlaySaved, applySavedOverlay, UUID, importOverlay,
      fileStore,
    };
  },
};
