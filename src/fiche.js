// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Captures de la visionneuse (« Image seule », « Avec annotations ») et fiches PDF des points de référence et des
// objets de la couche, sortis de la page (app.js) : état et fonctions de la page lus par Fiche.init.

const Fiche = (() => {
  const $ = (selector) => document.querySelector(selector);
  let host = null;  // état et fonctions de la page (app.js), donnés par init : lus à chaque appel
  const { sequenceApis } = Services;

  // Captures ----------------------------------------------------------------------------------
  // Chaque export (suivi par run) travaille sur ses propres copies : paramètres de la photo, image téléchargée, localisation et
  // vue relues au clic, fichier choisi avant le calcul. Fermer la visionneuse ou changer de photo ne le casse donc pas : il va
  // à son terme tout seul. Seule la fermeture de l'onglet l'interromprait : le navigateur demande alors confirmation.

  const CAPTURE_DONE_MS = 1500, CAPTURE_FAIL_MS = 5000;  // durée de la coche, de la croix d'échec sur le bouton
  let running = 0;  // exports en cours (les deux boutons)
  const timers = new Map();  // bouton -> minuterie de retour à l'état normal

  window.addEventListener("beforeunload", (event) => {
    if (!running) return;
    event.preventDefault();  // capture en cours : l'onglet ne se ferme pas sans confirmation
    event.returnValue = "";
  });

  /** « Image seule » : actif avec une photo ouverte et le calcul en arrière-plan prêt, sauf export en cours. */
  function updateCaptureButton() {
    const button = $("#capture-hd");
    button.disabled = button.dataset.etat === "en-cours" || !host?.photo || !Calcul.hasWorker();
  }
  document.addEventListener("calcul-worker", updateCaptureButton);  // calcul prêt après l'ouverture de la photo : bouton réveillé

  /** Suit un export sur son bouton : « en cours » (icône qui pulse, infobulle, non relançable), puis coche (CAPTURE_DONE_MS) en cas
   * de réussite, croix et message en cas d'échec. task rend le nom du fichier écrit, ou null si l'utilisateur renonce (rien à
   * signaler) ; refresh recalcule l'état grisé du bouton une fois fini. */
  async function run(button, label, task, refresh) {
    if (button.dataset.etat === "en-cours") return;
    clearTimeout(timers.get(button));
    const title = button.dataset.titre ?? button.title;
    button.dataset.titre = title;
    button.dataset.etat = "en-cours";
    button.disabled = true;
    button.title = "Capture en cours…";
    button.setAttribute("aria-busy", "true");
    running++;
    let etat = "", message = "";
    try {
      const file = await task();
      if (file) {
        etat = "fait";
        message = `Capture « ${label} » enregistrée : ${file}`;
        host.setStatus(message);
        host.noticeInFullscreen(message);
      }
    } catch (error) {
      console.warn(`Capture « ${label} » :`, error);
      etat = "echec";
      message = `Capture « ${label} » impossible : ${error.message}`;
      host.setStatus(message, "echec");
      host.notice(message);  // visible sur la visionneuse même si la ligne d'état est repliée
    } finally {
      running--;
      button.removeAttribute("aria-busy");
      button.dataset.etat = etat;
      if (!etat) delete button.dataset.etat;
      button.title = etat ? message : title;
      refresh();
      if (etat) {
        timers.set(button, setTimeout(() => {
          delete button.dataset.etat;
          button.title = title;
          delete button.dataset.titre;
        }, etat === "fait" ? CAPTURE_DONE_MS : CAPTURE_FAIL_MS));
      } else {
        delete button.dataset.titre;
      }
    }
  }

  $("#capture-hd").addEventListener("click", () => {
    if (!host.app || !host.psv) return;
    const { yaw, pitch } = host.psv.getPosition();
    const text = host.app.capture_args(yaw, pitch, host.viewFov(true));
    if (!text) {
      host.setStatus("Pas de photo HD pour cette photo : capture impossible.");
      return;
    }
    const params = JSON.parse(text), place = placeText();  // localisation lue maintenant : la visionneuse peut être fermée ensuite
    run($("#capture-hd"), "Image seule", async () => {
      const save = await host.saveAs(`${params.name}.jpg`, "image/jpeg");  // au clic, avant la capture (longue)
      if (!save) return null;
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
      drawCartouches(ctx, canvas, Math.max(14, Math.round(canvas.height / 54)), params.caption, place);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("image non encodée");
      await save(blob);
      return save.fileName;
    }, updateCaptureButton);
  });

  $("#vignette").addEventListener("click", () => {
    if (!host.psv) return;
    const date = (host.photo?.properties?.datetime || "").replace(/[^0-9]/g, "").slice(0, 8) || "sansdate";
    const name = `panoramax_vignette_${date}_${(host.photo?.id || "").slice(0, 8)}.png`;
    run($("#vignette"), "Avec annotations", async () => {
      await fontReady();
      const canvas = thumbnail();  // la vue au clic, avant la boîte « Enregistrer sous » : fermer la visionneuse ensuite est sans effet
      const save = await host.saveAs(name, "image/png");
      if (!save) return null;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("image non encodée");
      await save(blob);
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return `${save.fileName} (copiée dans le presse-papiers)`;
      } catch {
        return `${save.fileName} (copie dans le presse-papiers refusée par le navigateur)`;
      }
    }, () => document.dispatchEvent(new Event("annotations-changed")));
  });

  // Fiche PDF d'un point de référence ---------------------------------------------------------
  // Une page A4 : photo de la visionneuse en pleine largeur, cadrée sur la plus grande mesure du
  // point (10 % de marge), puis ses résultats et la méthode à côté de la mini-carte. Fenêtre à
  // part, imprimée par le navigateur (« Enregistrer au format PDF »).
  const FICHE_PHOTO = { width: 698, height: 356 }, FICHE_MAP = { width: 230, height: 300 };
  // Polices de la page (Inter, JetBrains Mono), pour la fenêtre de la fiche, document à part
  const FICHE_FONTS = ["inter@5.3.0/latin-400", "inter@5.3.0/latin-500", "inter@5.3.0/latin-700", "jetbrains-mono@5.3.0/latin-400"]
    .map((font) => `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/${font}.css">`).join("");
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
    const heading = host.viewHeading();
    if (!host.photo || heading == null) return;
    const p = host.map.project(host.photo.geometry.coordinates), x = p.x * scale, y = p.y * scale, r = 70 * scale;
    const half = Math.min(host.viewFov(), 170) / 2, rad = (d) => ((d - 90) * Math.PI) / 180;
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
    const canvas = host.map.getCanvas();
    if (!canvas.clientWidth || !canvas.clientHeight) return null;
    const before = { center: host.map.getCenter(), zoom: host.map.getZoom(), bearing: host.map.getBearing() };
    try {
      const [[w, south], [e, north]] = bounds;
      if (!asShown) host.map.jumpTo({ center: [(w + e) / 2, (south + north) / 2], zoom: before.zoom, bearing: 0 });
      // carte déjà immobile (vue actuelle, sans jumpTo) : « idle » ne viendrait plus, 8 s d'attente pour rien
      if (!asShown || !host.map.loaded())
        await Promise.race([new Promise((resolve) => host.map.once("idle", resolve)), new Promise((r) => setTimeout(r, 8000))]);
      return await new Promise((resolve) => {  // image WebGL lue juste après son rendu
        host.map.once("render", () => {
          try {
            const copy = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height });
            const ctx = copy.getContext("2d");
            ctx.drawImage(canvas, 0, 0);
            drawViewCone(ctx, canvas.width / canvas.clientWidth);
            drawScreenLabels(ctx, host.map.getContainer(), canvas.getBoundingClientRect(), canvas.width / canvas.clientWidth);
            resolve(cropCenter(copy, FICHE_MAP.width / FICHE_MAP.height, FICHE_MAP.width * canvas.width / canvas.clientWidth));
          } catch { resolve(null); }
        });
        host.map.triggerRepaint();
      });
    } finally {
      host.map.jumpTo(before);
    }
  }

  /** Choix de la photo de la fiche (cadrage automatique ou vue actuelle), puis la fiche : la fenêtre
   * s'ouvre au clic du choix, geste de l'utilisateur (sinon bloquée par le navigateur). */
  // k : n° du point de référence, ou { objet : n° de l'objet de la couche } (clic droit dans la photo),
  // ou { tous : true } (bouton de la couche : tous ses objets, en cadrage automatique seulement)
  function askFiche(k, text) {
    const dialog = $("#choix-fiche"), layered = typeof k === "object", all = Boolean(k?.tous);
    const n = host.overlay?.features.length;
    const name = all ? "" : layered ? host.overlayObjectName(k.objet) : (/^Point (\S+)/.exec(text) || [])[1] || "";
    dialog.querySelector("h2").firstChild.textContent = all ? `Fiches des ${n} objet${n > 1 ? "s" : ""} de la couche`
      : layered ? "Fiche de l'objet " : "Fiche du point ";
    dialog.querySelector("h2 span").textContent = name;
    // tous les objets : « Cadrage type », réglé sur le 1er (zoom, élévation) puis repris pour chacun
    dialog.querySelector(".vue-actuelle").textContent = all ? "Cadrage type…" : "Vue actuelle";
    dialog.querySelector(".fiche-point").hidden = layered;
    for (const el of dialog.querySelectorAll(".fiche-objet")) el.hidden = !layered;
    // texte libre, laissé tel quel ou modifié
    $("#titre-fiche").value = all ? host.overlay.name : layered ? `${host.overlay.name}, objet ${name}` : `point de référence ${name}`;
    if (layered) showFicheFields();
    dialog.querySelector(".fiche-tous").hidden = !all;
    if (all) showFicheObjects();
    else for (const b of dialog.querySelectorAll(".vue-actuelle, .cadrage-auto")) b.disabled = false;
    const frame = all ? null : showFicheFrame();
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (!dialog.returnValue) return dropFrame(frame);
      if (layered) {  // choix gardés avec la couche, pour la fiche des objets suivants
        host.overlay.fiche = [...$("#fiche-champs").children].map((li) => [li.dataset.champ, li.querySelector("input").checked]);
        host.saveOverlay();
        k = { ...k, champs: host.overlay.fiche.filter(([, on]) => on).map(([c]) => c) };
      }
      const title = $("#titre-fiche").value.trim();
      const ids = all ? [...$("#fiche-objets").querySelectorAll("input:checked")].map((box) => Number(box.value)) : [];
      if (all) return dialog.returnValue === "auto" ? makeFiches(ids, k.champs, title) : modelFiche(ids, k.champs, title)
        .catch((error) => host.setStatus(`Fiches impossibles : ${error.message}`, "echec"));
      if (dialog.returnValue === "auto" || !frame) {
        dropFrame(frame);
        return makeFiche(k, dialog.returnValue === "auto", title);
      }
      reframeFiche(frame, () => makeFiche(k, false, title));  // vue actuelle : recadrée d'abord
    }, { once: true });
    host.showOverViewer(dialog);
  }

  /** « Cadrage type » des fiches de tous les objets : photo du 1er objet ouverte et cadrée dessus ; zoom, élévation et
   * photo (tant de photos avant ou après la sienne dans la séquence) choisis par l'utilisateur (reframeFiche), puis
   * repris pour chaque objet, cap tourné vers lui (makeFiches). */
  async function modelFiche(ids, champs, title) {
    const first = await host.overlayFicheData(ids[0], null, true);
    if (first.photo && host.photo?.id !== first.photo) await host.openPhotoReady(first.photo);
    host.frameView(host.overlayEnds(ids[0]));
    reframeFiche(showFicheFrame(), () => {  // photo choisie lue dans la visionneuse (flèches comprises)
      makeFiches(ids, champs, title,
        { pitch: host.psv.getPosition().pitch, zoom: host.psv.getZoomLevel(),
        chosen: host.psv.getPictureMetadata?.()?.id || host.photo?.id });
    });
    host.setStatus(`Cadrage type sur l'objet ${host.overlayObjectName(ids[0])} : réglez le zoom et la hauteur de vue (molette, glisser), `
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
    await host.loadRanks(run, rank + offset).catch((error) => console.warn("Photo décalée dans la séquence :", error));
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
    bar.append(button("Annuler", "non", () => host.setStatus("Fiche annulée.")), button("✔ Valider le cadrage", "oui", go));
    frame.append(bar);
    const below = frame.offsetHeight - (frame.firstChild.offsetTop + frame.firstChild.offsetHeight);
    if (below >= 56) Object.assign(bar.style, { bottom: "auto", top: `${frame.offsetHeight - below + 10}px` });  // sous le cadre
    document.addEventListener("keydown", onKey, true);
    host.setStatus("Fiche : recadrez la vue dans la visionneuse et la mini-carte (glisser, molette) ; seul l'intérieur des cadres "
      + "sera repris. Puis « Valider le cadrage » (Échap pour annuler).");
  }

  /** Cadre de la photo que retiendrait « Vue actuelle » (cropCenter de la vue entière, au format de la
   * photo de la fiche), tracé sur la visionneuse, le reste assombri ; à retirer (remove) à la fermeture. */
  // Aussi sur la mini-carte (frame.linked) : le centre de sa capture (mapSnapshot), à l'échelle de l'écran
  function showFicheFrame() {
    const clip = frameOver(host.psv?.container, FICHE_PHOTO.width / FICHE_PHOTO.height, Infinity, "Cadre de la fiche (vue actuelle)");
    if (clip && !host.mapBox.hidden)
      clip.linked = frameOver(host.map.getCanvas(), FICHE_MAP.width / FICHE_MAP.height, FICHE_MAP.width, "Fiche");
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
    const columns = host.overlay.columns.filter((c) => !(host.overlay.techniques || []).includes(c));
    const kept = (host.overlay.fiche || []).filter(([c]) => columns.includes(c));
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
    const ol = $("#fiche-objets"), hidden = host.overlayHiddenTest();
    const buttons = $("#choix-fiche").querySelectorAll(".vue-actuelle, .cadrage-auto");
    const count = () => {
      const on = ol.querySelectorAll("input:checked").length;
      $("#fiche-objets-nombre").textContent = `${on} / ${ol.children.length}`;
      for (const b of buttons) b.disabled = !on;
      $("#fiche-objets-tous").disabled = on === ol.children.length;
      $("#fiche-objets-aucun").disabled = !on;
    };
    ol.replaceChildren(...host.overlay.features.map((f, id) => {
      const li = document.createElement("li"), label = document.createElement("label");
      const box = Object.assign(document.createElement("input"), { type: "checkbox", value: id, checked: !hidden(f) });
      box.addEventListener("change", count);
      const name = host.overlayObjectName(id);  // rang affiché quand le nom ne le donne pas (plage « Du … au … »)
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
    if (!host.app || !host.psv) return;
    // Ouverte tout de suite (après une attente, bloquée), en petite fenêtre à part : dans un onglet, la page
    // passerait en arrière-plan, où Chrome et Edge arrêtent requestAnimationFrame et la capture attendrait
    const win = window.open("", "_blank", "popup,width=520,height=420");
    if (!win) {
      host.setStatus("Fiche : fenêtre bloquée par le navigateur (autorisez les fenêtres de cette page).", "echec");
      return;
    }
    win.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiche — préparation</title>${FICHE_FONTS}<style>
body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
  font-family: Inter, Arial, sans-serif; color: #1c1c1c; background: #f5f5f3; }
.cercle { position: relative; width: 78px; height: 78px; }
.roue { position: absolute; inset: 0; border: 7px solid #ffd8bf; border-top-color: #e65100; border-radius: 50%;
  animation: tour 0.9s linear infinite; }
#pourcent { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 700; color: #e65100; }
@keyframes tour { to { transform: rotate(360deg); } }
h1 { margin: 0; font-size: 28px; } #etape { font-size: 17px; color: #444; min-height: 1.4em; }
p.aide { margin: 0; font-size: 14px; color: #555; }
@media (prefers-reduced-motion: reduce) { .roue { animation-duration: 3s; } }
</style></head><body><div class="cercle"><div class="roue"></div>
<div id="pourcent" role="progressbar" aria-label="Préparation en cours"
  aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">0 %</div></div>
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
      const seq = chosen?.collection || (await read((await host.overlayFicheData(ids[0], null, true)).photo))?.collection || null;
      if (chosen) {
        const base = await read((await host.overlayFicheData(ids[0], null, true, seq)).photo);
        view = { ...view, offset: base?.collection === seq ? rank(chosen) - rank(base) || 0 : 0 };
      }
      let doc = null;
      const n = ids.length, missed = [];
      for (const [i, id] of ids.entries()) {
        const name = host.overlayObjectName(id);
        try {
          // own : la photo de chaque objet, pas celle affichée (où des objets proches seraient tous dessinés)
          const html = await buildFiche({ objet: id, champs, own: true, seq }, view, `${title || host.overlay.name}, objet ${name}`,
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
        host.setStatus(`Fiches : ${missed.length} objet${missed.length > 1 ? "s" : ""} sans fiche : ${missed.join(" ; ")}.`, "echec");
      }
      if (!doc) throw new Error(`aucun objet n'a pu avoir sa fiche (${missed[0] || "couche vide"})`);
      return `<!doctype html>${doc.documentElement.outerHTML}`;
    }, true);
  }

  /** Vue de la visionneuse immobile (cap, élévation, zoom) depuis 400 ms, ses tuiles chargées, et redessinée : la
   * capture ne part ni pendant le mouvement de cadrage, ni sur une image encore floue ou incomplète (réseau lent).
   * 8 s au plus pour le mouvement, 20 s pour les tuiles. */
  async function viewSettled() {
    const key = () => {
      const p = host.psv.getPosition();
      return [p.yaw, p.pitch, host.psv.getZoomLevel()].map((v) => v.toFixed(5)).join();
    };
    let last = key(), since = Date.now();
    for (const t0 = Date.now(); Date.now() - t0 < 8000 && Date.now() - since < 400;) {
      await new Promise((r) => setTimeout(r, 100));
      const now = key();
      if (now !== last) [last, since] = [now, Date.now()];
    }
    // File des tuiles vide deux fois de suite (comme l'événement « picture-tiles-loaded » de la visionneuse)
    for (let t0 = Date.now(), empty = 0; empty < 2 && Date.now() - t0 < 20000;) {
      await new Promise((r) => setTimeout(r, 100));
      empty = Object.keys(host.psv.adapter?.queue?.tasks || {}).length ? 0 : empty + 1;
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
    const data = layered ? await host.overlayFicheData(k.objet, k.champs, k.own, k.seq) : JSON.parse(host.app.fiche(k));
    data.title = title || `point de référence ${data.name}`;
    if (!auto) data.photo = host.photo?.id || data.photo;  // pied de la fiche : la photo capturée
    if (auto?.offset) data.photo = await photoAtOffset(data.photo, auto.offset);  // cadrage type : même décalage dans la séquence
    step(auto ? "Ouverture de la photo de la mesure" : "Capture de la vue actuelle", 0);
    // Photo d'où la plus grande mesure a été prise (objet : la sienne) ; comparée à celle de la visionneuse, pas à la fiche
    // gardée (photo), qui peut retarder sur elle
    const shown = () => host.psv.getPictureMetadata?.()?.id;
    if (auto && data.photo && shown() !== data.photo) await host.openPhotoReady(data.photo);
    if (k.own && (!data.photo || shown() !== data.photo)) {  // fiches de tous les objets : jamais sur la photo d'un autre
      throw new Error(data.photo ? `photo ${data.photo} non ouverte` : "aucune photo trouvée près de l'objet (filtre, instance ?)");
    }
    step(auto ? "Cadrage de la photo sur la mesure" : "Capture de la vue actuelle", 40);
    const ends = !auto ? [] : layered ? host.overlayEnds(k.objet) : JSON.parse(host.app.fiche_frame(k));
    // Hauteur : la mesure sur 75 % de la hauteur de l'image ; largeur : 10 % de marge de chaque côté ;
    // objet de la couche : centré, champ de vue d'un point seul
    if (auto?.zoom !== undefined && ends.length) {
      host.psv.rotate({ yaw: ends[0][0], pitch: auto.pitch });
      host.psv.zoom(auto.zoom);
    } else host.frameView(ends, false,
    layered ? null : { aspect: FICHE_PHOTO.width / FICHE_PHOTO.height, margin: data.kind === "height" ? 1 / 0.75 : 1.25 });
    await viewSettled();
    if (auto && !layered && data.kind !== "height") {  // largeur : un peu de recul autour de la ligne ; hauteur : cadrage seul
      host.psv.zoom(Math.max(0, host.psv.getZoomLevel() - FICHE_UNZOOM));
      await viewSettled();
    }
    for (let t = 0; t < 20 && !placeText(); t++) await new Promise((r) => setTimeout(r, 250));  // lieu (route, PR) lu
    await fontReady();
    // Recadrée autour de la mesure : au bord de la photo, la vue ne peut pas se centrer dessus
    const view = thumbnail(), scale = view.width / host.psv.container.clientWidth;
    const xy = ends.map(([yaw, pitch]) => host.psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch }));
    const center = xy.length
      ? [xy.reduce((t, p) => t + p.x, 0) / xy.length * scale, xy.reduce((t, p) => t + p.y, 0) / xy.length * scale] : null;
    const picture = cropCenter(view, FICHE_PHOTO.width / FICHE_PHOTO.height, Infinity, center);
    step("Capture de la mini-carte", 75);
    if (layered && host.photo) {  // l'objet et la photo de la fiche
      const [lon, lat] = host.photo.geometry.coordinates;
      data.bounds = [[Math.min(lon, data.lon), Math.min(lat, data.lat)], [Math.max(lon, data.lon), Math.max(lat, data.lat)]];
    }
    const mapImage = await mapSnapshot(data.bounds, !auto);  // vue actuelle : la carte telle que recadrée
    step("Mise en page", 95);
    // déjà lu : sans requête
    if (host.photo) data.place = (await Lieu.describe(...host.photo.geometry.coordinates.slice(0, 2), host.photo).catch(() => ({}))).parts;
    // Sur un pont : son nom (sans la route, déjà écrite) et ce qu'il franchit, sans la hauteur de chute
    const onBridge = JSON.parse(host.app.fall_json());
    const [bridge, ...more] = (onBridge?.edges ? "" : onBridge?.text || "").split("\n");
    data.bridge = bridge ? [bridge.replace(/\s*\([^)]*\)$/, ""), more.find((t) => t.startsWith("Au-dessus"))].filter(Boolean) : [];
    return ficheHtml(data, picture, mapImage, JSON.parse(host.app.state()));
  }

  /** Fond de la mini-carte pour la fiche : nom officiel de la couche (titre publié par la Géoplateforme,
   * couche affichée pour l'ortho-express) et producteur. */
  function backgroundName() {
    const value = $("#fond").value;
    if (value === "ofm") return "OpenFreeMap (contributeurs d'OpenStreetMap)";
    const layer = (/LAYER=([^&]+)/.exec(host.map.getStyle()?.sources?.[value]?.tiles?.[0] || "") || [])[1] || "";
    const year = (/EXPRESS\.(\d{4})/.exec(layer) || [])[1];
    const name = value === "plan" ? "Plan IGN"
      : value === "express" && year ? `Ortho-express ${Number(year) >= 2025 ? "RVB " : ""}${year}`
      : value === "mnt" ? "Modèle Numérique de Terrain LiDAR HD"
      : value === "mns" ? "Modèle Numérique de Surface LiDAR HD"
      : value === "mnh" ? "Modèle Numérique de Hauteur LiDAR HD"
      : "Photographies aériennes";  // orthophoto, avec ou sans noms
    return `${name} (IGN)`;
  }

  /** Page de la fiche (voir la maquette du 24/10/2026) : HTML complet, styles compris. */
  function ficheHtml(data, picture, mapImage, state) {
    const e = host.escapeHtml, now = new Date();
    const date = `${now.toLocaleDateString("fr-FR")} · ${now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
    const place = placeText() || "Lieu inconnu";
    const placeHtml = [host.placeMarkup(place, data.place),  // route et commune en gras, comme dans la visionneuse
      ...data.bridge.map((t, i) => e(i ? t[0].toLowerCase() + t.slice(1) : t))].join(" – ");  // pont, au-dessus de…
    const background = backgroundName();
    const coords = `${data.lat.toFixed(5).replace(".", ",")}° N · ${data.lon.toFixed(5).replace(".", ",")}° E`;
    const api = Carte.apiUrl();
    const link = `${api.replace(/\/api\/?$/, "")}/#focus=pic&pic=${data.photo || host.photo?.id || ""}`;
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
      + `<td class='num'>${e(r.valeur || "—")}</td><td class='num'>${e(r.incert || "—")}</td>`
      + `<td class='com'>${e(r.commentaire || "")}</td></tr>`).join("");
    // Position de la photo, puis une ligne courte par mesure
    // (sans l'état de l'inclinaison ni son alerte : position seulement)
    const position = (state.quality || "").replace(/^⚠\s*/, "").split(" · ").filter((t) => !t.startsWith("inclinaison")).join(" · ");
    const lines = [position, ...data.texts].filter(Boolean).map((t) => `<li>${e(t)}</li>`).join("");
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8">`
      + `<title>Fiche ${e(data.name)} — Mesures Panoramax</title>${FICHE_FONTS}
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
/* jusqu'au pied : mini-carte centrée dans cette hauteur */
.bas { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) ${FICHE_MAP.width}px; gap: 24px; align-items: center; }
.textes { align-self: start; display: flex; flex-direction: column; gap: 16px; min-width: 0; }  /* tableau sous la photo */
h2 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.6px; color: #e65100; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; font-weight: 500; padding: 5px 6px; border-bottom: 1.5px solid #1c1c1c; }
td { padding: 6px; border-bottom: 1px solid #c8c8c8; vertical-align: top; } tr.point td { background: #f5f5f3; }
tr.mesure td { font-weight: 700; }
td.pt { font-weight: 700; white-space: nowrap; } .num { text-align: right; white-space: nowrap; } td.com { color: #444; }
ul { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.5; }
.carte-vide { height: ${FICHE_MAP.height}px; border: 1.5px dashed #888; border-radius: 4px; display: flex; align-items: center;
  justify-content: center; font-size: 12px; color: #555; text-align: center; padding: 8px; }
footer { margin-top: auto; border-top: 1px solid #c8c8c8; padding-top: 10px; font-size: 11.5px; color: #444;
  display: flex; align-items: center; gap: 16px; }
.pied { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.qr { flex: none; } .qr svg { display: block; width: 72px; height: 72px; }
footer a { color: #1a56c4; word-break: break-all; } .mono { font-family: "JetBrains Mono", monospace; color: #1c1c1c; }
@media screen { body { background: #888; } .page { margin: 16px auto; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.4); } }
</style></head><body><div class="page">
<header><div><h1>Mesures Panoramax</h1>
<div class="sous-titre">${data.attributes ? "Fiche d'objet" : "Fiche de mesure"} — ${e(data.title)}</div></div>
<div class="date">${e(date)}</div></header>
<section class="lieu"><div class="ou">${placeHtml}</div>
<span>${data.attributes ? "Objet" : "Point"} ${e(data.name)} : ${e(coords)}</span></section>
<figure><img src="${picture}" alt="Photo de la mesure, annotée"></figure>
<section class="bas"><div class="textes">
<div><h2>${data.attributes ? "Attributs" : "Résultats"}</h2><table>${table || `<thead><tr><th>Point</th><th>Mesure</th>
<th class="num">Valeur</th><th class="num">Incertitude</th><th>Commentaire</th></tr></thead><tbody>${rows}</tbody>`}</table></div>
<div><h2>Méthode et précision</h2><ul>${lines}</ul></div></div>
<figure>${mapImage ? `<img src="${mapImage}" alt="Mini-carte : ${data.attributes ? "objet" : "point"} ${e(data.name)}${
  data.attributes ? "" : " et ses mesures"}">` : "<div class='carte-vide'>Mini-carte indisponible (carte repliée, ou fond illisible)</div>"}
<figcaption>Fond de carte ${e(background)}</figcaption></figure></section>
<footer><div class="pied"><div>Photo <span class="mono">${e(data.photo || "")}</span> · ${e(host.app.caption())} · instance ${e(api)}</div>
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

  /** La visionneuse telle qu'affichée, avec ses annotations (mesures, couche, parcelle visée) et l'attribution. */
  function thumbnail() {
    const r = host.psv.renderer;
    r.renderer.render(r.scene, r.camera);  // image WebGL lue juste après son rendu
    const gl = r.renderer.domElement;
    const canvas = document.createElement("canvas");
    canvas.width = gl.width;
    canvas.height = gl.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(gl, 0, 0);
    const scale = gl.width / gl.clientWidth;
    const view = host.psv.getPosition();
    const screen = ([yaw, pitch]) => {
      // Point derrière la vue : pas dessiné
      const cos = Math.sin(pitch) * Math.sin(view.pitch)
        + Math.cos(pitch) * Math.cos(view.pitch) * Math.cos(yaw - view.yaw);
      if (cos <= 0.05) return null;
      const p = host.psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch });
      return [p.x * scale, p.y * scale];
    };
    ctx.lineCap = "round";
    // Couche importée affichée, sous tout le reste : traits et pastilles de sa couleur, puis ses
    // étiquettes visibles, prises à l'écran (écartées, masquées : comme dans la visionneuse)
    if (host.overlay && host.app && $("#couche-visible").checked) {
      const hidden = host.overlayHiddenTest();
      for (const o of JSON.parse(host.app.overlay_marks())) {
        const f = host.overlay.features[o.id];
        if (hidden(f)) continue;  // valeur masquée dans la légende, ou hors du filtre
        const { kind, pts: views } = host.overlayPoints(o);  // comme dans la visionneuse (drawViewerMarks)
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
      drawScreenLabels(ctx, host.psv.container, gl.getBoundingClientRect(), scale);
    }
    // Étiquette de la parcelle cadastrale visée (repère HTML), telle qu'affichée : section au-dessus du numéro
    for (const el of host.psv.container.querySelectorAll(".parcelle-visee")) {
      const r = el.getBoundingClientRect(), origin = gl.getBoundingClientRect(), css = getComputedStyle(el);
      if (!r.width) continue;
      ctx.save();
      ctx.font = `${css.fontWeight} ${parseFloat(css.fontSize) * scale}px ${css.fontFamily}`;
      Object.assign(ctx,
        { textAlign: "center", textBaseline: "middle", strokeStyle: "#fff", lineWidth: 3 * scale,
        lineJoin: "round", fillStyle: css.color });
      const lines = [...el.children].map((span) => span.textContent), x = (r.left + r.width / 2 - origin.left) * scale;
      lines.forEach((text, i) => {
        const y = (r.top - origin.top + r.height * (i + 0.5) / lines.length) * scale;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      });
      ctx.restore();
    }
    // Mesures : la surcouche WebGL de la visionneuse (traits, croix, étiquettes), telle qu'affichée
    const layer = Traits.snapshot();
    if (layer?.width) ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
    const caption = host.app ? host.app.caption() : "Panoramax";
    drawCartouches(ctx, canvas, 13 * scale, caption, placeText());  // taille de l'étiquette de la visionneuse
    return canvas;
  }

  const drawCartouches = Vignette.cartouches;  // src/vignette.js, partagé avec la page mobile

  /** Police Inter chargée, pour le texte dessiné dans les captures (sinon police de repli). */
  function fontReady() {
    return document.fonts ? document.fonts.load("500 12px Inter").catch(() => {}) : Promise.resolve();
  }

  /** Localisation affichée dans la visionneuse (route, PR, commune), ou "". */
  function placeText() {
    return $("#lieu").hidden ? "" : $("#lieu").textContent;
  }

  return {
    /** Branche l'objet sur la page : host donne l'état courant (photo, visionneuse…) et ses fonctions. */
    init: (page) => { host = page; },
    askFiche, buildFiche, paginateFiche, photoAtOffset, thumbnail, FICHE_FONTS, updateCaptureButton,
  };
})();
