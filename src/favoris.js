// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Photo loin des mesures (proposer de repartir de zéro), fiche de la photo affichée, aller à une photo par son
// identifiant, favoris gardés dans le navigateur (noms, liste, export et import).
// Sorti de la page (app.js) : Favoris.init s'exécute à la même place qu'avant.

const Favoris = {
  /** Branche la photo éloignée et les favoris sur la page ; host : etat (état partagé), fonctions de la page, et
   * noms déclarés plus bas (lus à chaque appel). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      etat, refresh, showOverViewer, photoProducer, openPhoto, map, store, notice, download, exportName,
    } = host;

    // Photo loin des mesures : proposer de repartir de zéro ------------------------------------

    const FAR_FROM_MEASURES = 100;  // m
    let farAsked = false;  // déjà proposé pour cet éloignement : redemandé après un retour près des mesures

    /** Distance (m) de la photo en lonlat à la mesure la plus proche (points triangulés, cibles des
     * visées, points et traits des mesures), ou null sans mesure. Les traits de visée partent des
     * photos, la droite de mesure et le calage ne comptent pas. */
    function distanceToMeasures(lonlat) {
      if (!etat.app) return null;
      const kinds = new Set(["mesure", "point", "etiquette", "triangule", "cible", "distance"]);
      const k = Math.cos(lonlat[1] * Math.PI / 180) * 111320;
      let best = null;
      for (const f of JSON.parse(etat.app.map_geojson()).features) {
        if (!kinds.has(f.properties.kind)) continue;
        const coords = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const [lon, lat] of coords) {
          const d = Math.hypot((lon - lonlat[0]) * k, (lat - lonlat[1]) * 111320);
          if (best == null || d < best) best = d;
        }
      }
      return best;
    }

    function checkFarFromMeasures(lonlat) {
      if ($("#mode").value === "releve") return;  // relevé : on avance le long de la voie, objet après objet
      const d = distanceToMeasures(lonlat);
      if (d == null || d <= FAR_FROM_MEASURES) {
        farAsked = false;
        return;
      }
      const dialog = $("#loin-mesures");
      if (farAsked || dialog.open) return;
      farAsked = true;
      host.stopPlayer();  // lecture de la séquence arrêtée le temps de répondre
      dialog.querySelector("p span").textContent = d >= 1000 ? `${(d / 1000).toFixed(1).replace(".", ",")} km`
        : `${Math.round(d)} m`;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => {
        if (dialog.returnValue === "oui") refresh(etat.app.clear_all());
      }, { once: true });
      showOverViewer(dialog);
    }

    function showPhotoInfo(feature, message) {
      const section = $("#fiche");
      $("#photo-copier").disabled = !feature;
      if (!feature) {
        $("#photo-titre").textContent = "Aucune photo";
        $("#photo-infos").textContent = message || "";
        section.replaceChildren(Object.assign(document.createElement("p"), { className: "aide", textContent: "—" }));
        return;
      }
      const p = feature.properties || {};
      // En-tête : date de prise de vue, producteur et caméra
      const when = p.datetime ? new Date(p.datetime) : null;
      $("#photo-titre").textContent = when && !isNaN(when)
        ? when.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }) : "Date inconnue";
      $("#photo-infos").textContent = [photoProducer(feature), (p["pers:interior_orientation"] || {}).camera_model]
        .filter(Boolean).join(" · ");
      $("#photo-copier").onclick = () => host.copyText(feature.id, $("#photo-copier"));
      const accuracy = p["quality:horizontal_accuracy"];
      const rows = [
        ["Précision GPS annoncée", accuracy != null ? `${String(accuracy).replace(".", ",")} m` : "—"],
        ["Identifiant", feature.id],
      ];
      const dl = document.createElement("dl");
      for (const [label, value] of rows) {
        const dd = Object.assign(document.createElement("dd"), { textContent: value || "—" });
        if (label === "Précision GPS annoncée") {
          // À la suite : précision calculée (vérification RTK sur le sol LiDAR HD ou RGE ALTI), mise à
          // jour par refresh quand la vérification arrive
          const computed = Object.assign(document.createElement("span"), { className: "precision-calculee" });
          dd.append(" · calculée ", computed);
        }
        if (label === "Identifiant") dd.className = "identifiant";
        dl.append(Object.assign(document.createElement("dt"), { textContent: label }), dd);
      }
      section.replaceChildren(dl);
    }

    // Aller à une photo par son identifiant (ou un lien Panoramax qui le contient)
    $("#id-photo").addEventListener("input", () => {
      $("#aller-photo button").disabled = !$("#id-photo").value.trim();  // champ vide : sans effet
    });
    $("#aller-photo").addEventListener("submit", async (event) => {
      event.preventDefault();
      const help = $("#aller-photo .aide");
      const match = $("#id-photo").value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      help.hidden = false;
      if (!match) {
        help.textContent = "Identifiant non reconnu : collez l'identifiant de la photo (8-4-4-4-12 caractères).";
        return;
      }
      help.textContent = "Recherche de la photo…";
      try {
        const feature = await Carte.photoById(match[0].toLowerCase());
        if (!feature) {
          help.textContent = "Photo introuvable sur l'instance choisie (Filtre › Instance).";
          return;
        }
        help.hidden = true;
        $("#id-photo").value = "";
        openPhoto(feature);
        map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
      } catch (error) {
        help.textContent = `Recherche impossible : ${error.message}`;
      }
    });
    // Les touches de la boîte ne vont ni à la carte ni aux recalages au clavier
    $("#id-photo").addEventListener("keydown", (event) => event.stopPropagation());

    // Favoris : photos gardées dans le navigateur, nommées « hameau – commune – voie – PR – pont »
    function favorites() {
      try { return JSON.parse(store.get("favoris", "[]")) || []; } catch { return []; }
    }

    /** Nom d'un favori, commune et voie en gras (gardées à l'ajout ; favori plus ancien : la voie
     * reconnue à sa forme, la commune juste avant elle dans le nom « lieu-dit – commune – voie – PR – pont »). */
    const VOIE = /^(?:[ADNM]|RD|RN|VC)\s?\d|^(?:rue|route|chemin|avenue|boulevard|place|impasse|allée|quai|voie|véloroute)\b/i;
    function favoriteName(f) {
      const parts = f.name.split(" – ");
      const strong = new Set([f.commune, f.voie].filter(Boolean));
      if (!strong.size) {
        const k = parts.findIndex((p) => VOIE.test(p));
        if (k >= 0) [parts[k], parts[k - 1]].filter(Boolean).forEach((p) => strong.add(p));
      }
      return parts.flatMap((p, k) => [...(k ? [" – "] : []),
        strong.has(p) ? Object.assign(document.createElement("strong"), { textContent: p }) : p]);
    }

    function showFavorites() {
      $("#favoris ol").replaceChildren(...favorites().map((f) => {
        // photo affichée : entourée
        const li = Object.assign(document.createElement("li"), { className: etat.photo?.id === f.id ? "actuelle" : "" });
        const go = Object.assign(document.createElement("button"), {
          type: "button", className: "aller-favori",
          title: etat.photo?.id === f.id ? "Photo affichée" : `Aller à la photo ${f.id}`,
        });
        go.append(...favoriteName(f));
        go.addEventListener("click", async () => {
          try {
            const feature = await Carte.photoById(f.id);
            if (!feature) return notice("Photo du favori introuvable sur l'instance choisie (Filtre › Instance).");
            openPhoto(feature);
            map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
          } catch (error) {
            notice(`Favori : recherche impossible (${error.message})`);
          }
        });
        const remove = Object.assign(document.createElement("button"), {
          type: "button", className: "effacer-resultat", textContent: "×", title: "Retirer ce favori",
        });
        remove.setAttribute("aria-label", `Retirer le favori : ${f.name}`);
        remove.addEventListener("click", () => removeFavorite(f.id));
        li.append(go, remove);
        return li;
      }));
      $("#favoris-exporter").disabled = !favorites().length;
      $("#compte-favoris").textContent = favorites().length || "";
      const n = favorites().length;
      $("#favoris-infos").textContent = n ? `${n} photo${n > 1 ? "s" : ""} · gardée${n > 1 ? "s" : ""} dans ce navigateur` : "Aucune photo";
      // Étoile de la visionneuse : pleine si la photo affichée est en favori
      const on = Boolean(etat.photo) && favorites().some((f) => f.id === etat.photo.id);
      $("#ajouter-favori").disabled = !etat.photo || on;  // déjà en favori : sans effet
      $("#ajouter-favori").classList.toggle("en-favori", on);  // étoile pleine
      $("#ajouter-favori").title = on ? "Photo déjà en favori (son étoile sur la photo la retire)" : "Ajouter cette photo aux favoris";
      Object.assign($("#etoile-favori"), { hidden: !etat.photo,
        title: on ? "Retirer cette photo des favoris" : "Ajouter cette photo aux favoris" });
      $("#etoile-favori").setAttribute("aria-pressed", String(on));
    }

    function removeFavorite(id) {
      store.set("favoris", JSON.stringify(favorites().filter((x) => x.id !== id)));
      showFavorites();
    }

    $("#etoile-favori").addEventListener("click", () => {
      if (etat.photo && favorites().some((f) => f.id === etat.photo.id)) removeFavorite(etat.photo.id);
      else host.addFavorite();
    });
    $("#ajouter-favori").addEventListener("click", () => host.addFavorite());
    // Export et import des favoris (autre poste, autre navigateur) : fichier JSON [{ id, name }]
    $("#favoris-exporter").addEventListener("click", async () => download(JSON.stringify(favorites(), null, 1),
      await exportName("favoris", "json"), "application/json"));

    return {
      showPhotoInfo, showFavorites, checkFarFromMeasures, favorites,
    };
  },
};
