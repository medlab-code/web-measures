// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Relevé d'objets (champs, fiches, envoi dans Couche), dossier de travail (tout le travail en un fichier, export et
// import), modèles de champs, résultats gardés d'une séance à l'autre, import des calages.
// Sorti de la page (app.js) : Releve.init s'exécute à la même place qu'avant.

const Releve = {
  /** Branche le relevé et le dossier de travail sur la page ; host : etat (état partagé) et fonctions de la page.
   * Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      store, etat, parcours, refreshPoiTargets, exportOverlay, showOverViewer, loadOverlay, setOverlayFile,
      setOverlayChanged, saveOverlay, showPane, refresh, setStatus, download, exportName, fileInput, map, savedRoutes,
      favorites, overlaySaved, notice, applySavedOverlay, importRoutes, importFavorites, UUID, goToPhoto,
    } = host;

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
      const n = JSON.parse(etat.app.results()).filter((r) => r.releve).length;
      $("#releve-couche").disabled = !n;
      $("#releve-vider").disabled = !n;
      $("#releve-infos").textContent = n ? `${n} objet${n > 1 ? "s" : ""}` : "Aucun objet";
      const json = n ? etat.app.releve_json() : "";
      if (json !== releveSaved || !parcours.poiTargets.size !== !n) refreshPoiTargets(json);
      if (json === releveSaved) return;
      releveSaved = json;
      store.set("releve", json);
    }

    // Relevé envoyé dans Couche (il y prend les réglages d'une couche importée) ; une couche chargée est
    // d'abord retirée, enregistrée si on le demande
    $("#releve-couche").addEventListener("click", () => {
      if (!etat.overlay) return sendReleve();
      const dialog = $("#remplacer-couche");
      dialog.querySelector("p span").textContent = etat.overlay.name;
      dialog.returnValue = "";
      dialog.addEventListener("close", async () => {
        if (dialog.returnValue === "enregistrer" && !(await exportOverlay())) return;  // enregistrement annulé : rien ne change
        if (dialog.returnValue) sendReleve();
      }, { once: true });
      showOverViewer(dialog);
    });
    async function sendReleve() {
      const data = JSON.parse(etat.app.export_geojson(true));
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
      const dialog = $("#vider-releve"), n = JSON.parse(etat.app.results()).filter((r) => r.releve).length;
      dialog.querySelector("p span").textContent = `${n} objet${n > 1 ? "s" : ""}`;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => {
        if (dialog.returnValue === "vider") refresh(etat.app.clear_releve());
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
      const others = etat.app.has_releve() ? JSON.parse(etat.app.releve_json()).points.map(([, , v]) => v.releve || {}) : [];
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
      const filled = new Set([...RELEVE_RESERVES, ...etat.overlay.techniques, ...KML_TECHNIQUES, "latitude", "longitude"]
        .map((c) => c.toLowerCase()));
      return etat.overlay.columns.filter((c) => c.trim() && !filled.has(c.toLowerCase())).map((nom) => {
        const values = etat.overlay.features.map((f) => f.properties[nom]).filter((v) => v !== null && v !== undefined && v !== "");
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
      named.placeholder = etat.overlay.name.replace(/\.[^.]+$/, "").slice(0, 60);
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
      const objects = JSON.parse(etat.app.results()).filter((r) => r.releve);
      const row = k == null ? objects.reduce((a, b) => (b.id > a.id ? b : a), objects[0]) : objects.find((r) => r.id === k);
      if (!row) return;
      const kept = JSON.parse(etat.app.releve_json()).points.find(([, , v]) => v.nom === /^Objet (\S+)/.exec(row.text)[1])?.[2] || {};
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
        etat.app.set_comment("point", row.id, $("#releve-commentaire input").value.trim());
        refresh(etat.app.set_releve(row.id, JSON.stringify(out)));
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
    let savedKey = null;
    function saveResults() {  // à chaque rafraîchissement : écrit seulement ce qui a changé
      clearTimeout(etat.saveTimer);
      if (!etat.app) return;
      const geojson = etat.app.export_geojson(), key = geojson + (geojson === etat.exported);  // exporté depuis : réécrit
      if (key === savedKey) return;
      savedKey = key;
      const n = JSON.parse(geojson).features.length;  // en mesure libre, points et distances hors de la liste (#30)
      const saved = store.set("resultats", n ? JSON.stringify({ when: Date.now(), n, exported: geojson === etat.exported,
        csv: etat.app.export_csv(), geojson }) : "");
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
    const releveCount = () => JSON.parse(etat.app.releve_json()).points.length;
    const calibrationCount = (c) => ["verticals", "landmarks", "heights", "auto"].reduce((t, k) => t + Object.keys(c?.[k] || {}).length, 0);
    /** « Exporter le dossier » grisé tant qu'il n'y a rien à y mettre (à l'ouverture des réglages, et après un import). */
    function showFolderExport() {
      $("#dossier-exporter").disabled = !etat.app || !(etat.overlay || releveCount()
        || calibrationCount(JSON.parse(etat.app.calibration_json())) || savedRoutes().length
          || favorites().length || releveModels().length);
    }
    /** Dossier de travail (objet du fichier) : seules les parties non vides. */
    function workFolder() {
      const calibration = JSON.parse(etat.app.calibration_json());
      return { format: DOSSIER_FORMAT, version: 1, date: new Date().toISOString(),
        ...(etat.overlay && { couche: overlaySaved() }),
        ...(releveCount() && { releve: { objets: JSON.parse(etat.app.releve_json()), champs: releveFields() } }),
        ...(calibrationCount(calibration) && { calage: calibration }),
        ...(savedRoutes().length && { parcours: savedRoutes() }),
        ...(favorites().length && { favoris: favorites() }),
        ...(releveModels().length && { modeles: releveModels() }),
        ...(etat.photo && { photo: etat.photo.id }) };
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
          && { key: "couche", checked: !etat.overlay, text: `Couche « ${d.couche.name} » (${n(d.couche.features.length, "objet")})`,
          help: etat.overlay ? `remplacera votre couche « ${etat.overlay.name} »` : "deviendra votre couche",
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
            refresh(etat.app.clear_releve());
            store.set("releve-champs", JSON.stringify(d.releve.champs || []));
            refresh(etat.app.load_releve(JSON.stringify(d.releve.objets)));
          } },
        calibrationCount(d.calage) && { key: "calage", checked: true,
          text: `Calage (${n(calibrationCount(d.calage), "photo ou séquence", "photos ou séquences")})`,
          help: "complétera le vôtre", apply: () => importCalibration(JSON.stringify(d.calage)) },
        d.parcours?.length && { key: "parcours", checked: true, text: n(d.parcours.length, "parcours", "parcours"),
          help: "ajoutés aux vôtres", apply: () => importRoutes({ parcours: d.parcours }) },
        d.favoris?.length && { key: "favoris", checked: true, text: n(d.favoris.length, "favori"),
          help: "ajoutés aux vôtres", apply: () => importFavorites(d.favoris) },
        d.modeles?.length && { key: "modeles", checked: true, text: n(d.modeles.length, "modèle de champs", "modèles de champs"),
          help: "ajoutés aux vôtres (même nom : remplacé)",
          apply: () => importModels({ format: MODELES_FORMAT, modeles: d.modeles }, name) },
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

    $("#calage-exporter").addEventListener("click", async () => download(etat.app.calibration_json(), await exportName("calage", "json"),
      "application/json"));
    $("#calage-importer").addEventListener("click", () => $("#calage-fichier").click());
    fileInput("#calage-fichier", (data, name, text) => importCalibration(text));
    /** Calage lu d'un fichier (texte JSON), complétant celui en mémoire. */
    function importCalibration(text) {
      const added = etat.app.merge_calibration(text);
      refresh(added < 0 ? "Fichier de calage illisible." : added === 0
        ? "Calage importé : rien de nouveau (photos et séquences déjà calées)."
        : `Calage importé pour ${added} photo${added > 1 ? "s" : ""} ou séquence${added > 1 ? "s" : ""}.`);
    }

    return {
      showFolderExport, saveResults, saveReleve, editReleve, fieldsError, overlayFields, importModels, importCalibration,
      importFolder, DOSSIER_FORMAT, MODELES_FORMAT,
    };
  },
};
