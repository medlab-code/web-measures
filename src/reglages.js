// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Réglages de l'affichage gardés dans le navigateur (fond de carte, filaire, inclinaison par le terrain, droite de mesure,
// filtrage anisotrope, PR, cadastre, parcelle visée) et fenêtre du profil en travers (« Profil » : loupe, légende,
// analyse fine du nuage LiDAR). Sorti de la page (app.js) : Reglages.init s'exécute à la même place qu'avant.

const Reglages = {
  /** Branche les réglages et la fenêtre du profil sur la page ; host : etat (état partagé), fonctions de la page,
   * et noms déclarés plus bas (lus à chaque appel). */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      store, map, etat, refresh, showOverViewer, mainZone, saveAs, setStatus, FICHE_FONTS, placeMarkup, escapeHtml,
    } = host;

    $("#fond").value = store.get("fond", "plan").replace(/^osm$/, "ofm");  // OpenStreetMap France remplacé par OpenFreeMap
    if (!$("#fond").value) $("#fond").value = "plan";  // fond mémorisé qui n'existe plus
    map.on("load", () => Carte.setBackground(map, $("#fond").value));
    // Police des cartouches prête avant qu'ils ne soient dessinés
    document.fonts?.load("700 24px Inter").catch(() => {});
    Carte.showAdmin(map);  // limites des départements et des métropoles ; des communes avec « orthophoto avec noms »
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
      if (etat.app) refresh(etat.app.set_terrain_relay(event.target.checked));
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
      if (etat.app) { etat.app.set_edge_zone(Number(edgeZone.value)); refresh(); }
    });
    $("#bords").addEventListener("click", () => { etat.app.request_edges(); refresh(); });
    // « Profil » : coupe du terrain du dernier calcul de « Profils » pour la photo affichée
    // Case « Hauteurs à l'échelle » : cochée à chaque ouverture du profil (caméra à sa hauteur), grisée quand les hauteurs sont déjà à l'échelle (pas d'exagération possible)
    const trueScale = $("#profil-echelle");
    // Case « Végétation » (analyse fine : ligne verte, herbe), de même retenue ; cochée par défaut, grisée sans analyse fine
    const plants = $("#profil-vegetation");
    plants.checked = store.get("profil-vegetation") !== "0";
    plants.addEventListener("change", () => {
      store.set("profil-vegetation", plants.checked ? "1" : "0");
      if (etat.edgeProfile) drawProfile(true);
    });
    // Case « Bord d'enrobé (expérimental) » : bord d'enrobé et bordure de l'analyse fine déplacent les bords de chaussée ;
    // décochée par défaut (souvent trop loin : accotements et trottoirs en enrobé), choix retenu, grisée sans analyse fine
    const paving = $("#profil-enrobe");
    paving.checked = store.get("profil-enrobe") === "1";
    paving.addEventListener("change", () => {
      store.set("profil-enrobe", paving.checked ? "1" : "0");
      const profile = etat.edgeProfile?.profile, found = nuage.get(nuageKey(profile));
      if (!found) return;
      applyPaved(profile, found);  // bords relus sans relire le nuage
      drawProfile(true);
    });
    trueScale.checked = true;
    // still : redessin par une case (échelle, végétation) : la légende, au-dessus des cases et boutons, ne raccourcit pas
    // (lignes de l'herbe et de la végétation retirées) pour qu'ils ne bougent pas ; un nouveau profil la remet à sa taille
    const echelleLabel = trueScale.closest("label"), echelleTitre = echelleLabel.title;
    let frameKept = null;  // cadre du dernier dessin : { key (repère du travers), cadre, trueScale }
    const drawProfile = (still = false) => {
      const dialog = $("#fenetre-profil"), box = dialog.querySelector(".legende");
      box.style.minHeight = still && box.offsetHeight ? `${box.offsetHeight}px` : "";
      const found = nuage.get(nuageKey(etat.edgeProfile.profile));
      // option décochée : séparateur, lignes, herbe, végétation et eau restent, sans bords ni largeur d'enrobé
      const fine = found && !paving.checked ? { ...found, bords: {}, largeur: null } : found;
      // Redessin par une case : cadre du dessin précédent du même travers gardé (bornes en distance, hauteurs et échelle),
      // car changer les bords déplace le milieu de la chaussée, donc la zone lue, et le graphique glisserait ; « Hauteurs à
      // l'échelle » change l'échelle des hauteurs : bornes en distance seulement. Un nouveau dessin (ouverture, analyse
      // fine finie) recalcule le cadre
      const key = nuageKey(etat.edgeProfile.profile), kept = still && frameKept?.key === key ? frameKept : null;
      const imposed = kept ? { x: kept.cadre.x, z: kept.trueScale === trueScale.checked ? kept.cadre.z : null } : null;
      const { svg, legend, long, cadre, exageration } = Profil.draw(etat.edgeProfile.profile, trueScale.checked, fine,
        plants.checked, Number($("#camera").value) || 1.9, imposed);  // hauteur de caméra des réglages
      frameKept = { key, cadre, trueScale: trueScale.checked };
      trueScale.disabled = exageration <= 1;  // l'exagération vaudrait ×1 : la case n'aurait aucun effet
      echelleLabel.title = trueScale.disabled ? `${echelleTitre} : hauteurs déjà à l'échelle sur ce travers, pas d'exagération possible` : echelleTitre;
      dialog.querySelector(".graphique").replaceChildren(svg, ...(long ? [long] : []));  // profil en long dessous
      $("#profil-pdf-long").disabled = !long;  // pas de 2e page sans profil en long
      dialog.querySelector(".legende").replaceChildren(legend);
    };
    trueScale.addEventListener("change", () => {
      if (etat.edgeProfile) drawProfile(true);
    });
    // Loupe : graphique le plus grand possible (sans la légende) sans que la fenêtre dépasse de la grande zone principale
    // (que la visionneuse ou la carte y soit, comme la fenêtre elle-même) ; l'image PNG n'en dépend pas
    const fitProfile = () => {
      const dialog = $("#fenetre-profil"), chart = dialog.querySelector(".graphique");
      chart.style.width = "";
      dialog.style.maxWidth = "";
      if (!dialog.classList.contains("agrandi")) return;
      const box = mainZone().getBoundingClientRect();
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
      // Le bas de la fenêtre est gardé quand son contenu change (showOverViewer) : pliée ou dépliée, elle est recentrée
      $("#fenetre-profil").dispatchEvent(new Event("recentrer"));
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
      if (!etat.edgeProfile) return;
      const dialog = $("#fenetre-profil"), feature = etat.photo;
      const title = dialog.querySelector("h2");
      title.textContent = "Profil en travers" + (etat.edgeProfile.road ? ` · ${etat.edgeProfile.road}` : "");
      trueScale.checked = true;  // à l'échelle à chaque ouverture
      foldLegend(true);
      const known = nuage.get(nuageKey(etat.edgeProfile.profile));
      if (known) applyPaved(etat.edgeProfile.profile, known);  // l'état Python suit la case, même pour un profil analysé plus tôt
      drawProfile();
      $("#profil-nuage-etat").textContent = "";
      nuageReady();
      showOverViewer(dialog, true);  // sur la grande zone, quel que soit l'échange carte / visionneuse
      // Route, PR et commune de la photo, comme l'étiquette du lieu (déjà lus : sans requête)
      Lieu.describe(...feature.geometry.coordinates.slice(0, 2), feature).then(({ parts }) => {
        const place = [parts.voie || etat.edgeProfile.road, parts.pr, parts.commune].filter(Boolean).join(" – ");
        if (place && etat.photo === feature && dialog.open) title.textContent = `Profil en travers · ${place}`;
      }).catch(() => {});
    });
    // « Analyse fine » : nuage LiDAR HD lu pour le travers de la photo (src/nuage.js), gardé pour ce profil ; grisé pendant
    // la lecture et une fois faite
    // rangée sous le repère du travers : le calcul renvoie un nouvel objet profil à chaque rafraîchissement
    const nuage = new Map(), nuageKey = (profile) => JSON.stringify(profile?.repere);
    // « Végétation » grisée tant que l'analyse fine n'a rien fourni pour ce profil (son choix reste retenu)
    const nuageReady = () => {
      const done = nuage.has(nuageKey(etat.edgeProfile?.profile));
      $("#profil-nuage").disabled = !etat.edgeProfile?.profile?.repere || done;
      $("#profil-vegetation").disabled = !done;
      $("#profil-enrobe").disabled = !done;
    };
    // Bords d'enrobé trouvés (option cochée) : plateforme, chute et dévers du profil relus depuis eux ; sinon (décochée,
    // ou rien trouvé) le calcul reprend les bords du relief. Seuls les bords passent à Python, le séparateur reste à la page
    const pavedSent = new Map();  // repère -> JSON des bords d'enrobé transmis à Python ("{}" ou absent : aucun)
    const applyPaved = (profile, found) => {
      const paved = paving.checked ? Object.fromEntries(Object.entries(found.bords).filter(([, b]) => b?.comment === "enrobé")
        .map(([side, b]) => [side, Math.abs(b.x)])) : {};
      const frame = JSON.stringify(profile.repere), wanted = JSON.stringify(paved);
      if (wanted === (pavedSent.get(frame) ?? "{}")) return;  // déjà dans cet état : pas de recalcul (ni de boucle)
      etat.app.use_paved_edges(frame, wanted);
      pavedSent.set(frame, wanted);
      refresh();
    };
    $("#profil-nuage").addEventListener("click", async () => {
      const profile = etat.edgeProfile?.profile, state = $("#profil-nuage-etat");
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
        applyPaved(profile, found);
        state.textContent = `Nuage LiDAR HD : ${found.points} points du sol, ${found.requetes} requêtes, ${found.secondes} s.`;
        if (nuageKey(etat.edgeProfile?.profile) === nuageKey(profile)) drawProfile();
      } catch (error) {
        state.textContent = `Analyse fine impossible : ${error.message}`;
      } finally {
        bar.hidden = true;
        nuageReady();
      }
    });
    $("#profil-png").addEventListener("click", async () => {
      const dialog = $("#fenetre-profil"), title = dialog.querySelector("h2").textContent;
      const id = etat.psv?.getPictureMetadata?.()?.id || "photo";
      const save = await saveAs(`profil-${etat.edgeProfile?.road || "route"}-${id.slice(0, 8)}.png`, "image/png");  // au clic
      if (!save) return;
      await save(await Profil.png(dialog.querySelector("svg"), title, dialog.querySelector(".legende"),
        dialog.querySelector("svg.profil-long")));
      setStatus("Profil enregistré en PNG.");
    });
    $("#profil-pdf-long").checked = store.get("profil-pdf-long") === "1";
    $("#profil-pdf-long").addEventListener("change", (event) => store.set("profil-pdf-long", event.target.checked ? "1" : "0"));
    $("#profil-pdf").addEventListener("click", async () => {
      const dialog = $("#fenetre-profil"), meta = etat.psv?.getPictureMetadata?.(), feature = etat.photo;
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
        place: text ? placeMarkup(text, parts) : escapeHtml(etat.edgeProfile?.road || ""),
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
      if (!etat.app) return;
      if (!event.target.checked && etat.lineDraft !== null) host.endLineDraft();
      refresh(!event.target.checked && JSON.parse(etat.app.axis_state()).drawn ? etat.app.cancel_measure_line() : undefined);
    });
    // Filtrage anisotrope 16x des textures du panorama (4x dans le plugin), contre le crénelage et
    // le scintillement des détails fins vus de loin. Photo Sphere Viewer crée ses textures sans
    // mipmaps, sans lesquels l'anisotropie n'a guère d'effet : on les active (trilinéaire).
    // Chaque texture n'est traitée qu'une fois ; décoché, le filtre d'origine revient.
    function anisotropic(on) {
      const r = etat.psv?.renderer;
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
      if (changed) etat.psv.needsUpdate?.();
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
    // Parcelle visée dans la visionneuse (étiquette et croix), cochée par défaut ; grisée sans le cadastre
    $("#cadastre-visionneuse").checked = store.get("cadastre-visionneuse") !== "0";
    $("#cadastre-visionneuse").disabled = !$("#cadastre").checked;
    $("#cadastre").addEventListener("change", (event) => {
      store.set("cadastre", event.target.checked ? "1" : "0");
      Carte.setCadastre(map, event.target.checked);
      $("#cadastre-visionneuse").disabled = !event.target.checked;
      host.applyMeasureUi();  // croix du centre de la vue
    });
    $("#cadastre-visionneuse").addEventListener("change", (event) => {
      store.set("cadastre-visionneuse", event.target.checked ? "1" : "0");
      host.applyMeasureUi();
      host.showParcelMark();
    });
    $("#anisotrope").checked = store.get("anisotrope") === "1";
    $("#anisotrope").addEventListener("change", (event) => {
      store.set("anisotrope", event.target.checked ? "1" : "0");
      anisotropic(event.target.checked);
    });
    // Toutes les secondes, pour les tuiles chargées au fil de la navigation
    setInterval(() => { if ($("#anisotrope").checked) anisotropic(true); }, 1000);
  },
};
