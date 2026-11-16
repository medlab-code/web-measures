// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vérification des services appelés depuis le navigateur : un échec signale un proxy, un
// pare-feu ou un en-tête CORS manquant sur le poste. Adresses de l'API d'une séquence (app.js, dessus.js).

const Services = (() => {
  const { GEOPF, OFM_STYLE, PANORAMAX_API } = Carte;

  const SERVICES = [
    ["Panoramax : recherche de photos", `${PANORAMAX_API}/search?limit=1`],
    ["Panoramax : filaire (tuiles)", `${PANORAMAX_API}/map/14/8396/5876.mvt`],
    ["Panoramax : photos de l'IGN", "https://panoramax.ign.fr/api/search?limit=1"],
    // Fichiers des photos (HD : capture, inclinaison automatique), hébergés à part : vignette
    // d'une photo de l'IGN, sur le même stockage que sa version HD (plus légère à vérifier)
    ["Panoramax : fichiers des photos (stockage)",
      "https://panoramax.ign.fr/api/pictures/cd8cf3a0-6567-40f0-8805-94172a5dfc3c/thumb.jpg"],
    // Une petite réponse par service : leurs GetCapabilities pesaient près de 10 Mo, à chaque ouverture (16/11/2026)
    ["IGN : fonds de carte (WMTS)", `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2`
      + "&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=0&TILEROW=0&TILECOL=0&FORMAT=image/png"],
    ["OpenFreeMap : fond OpenStreetMap", OFM_STYLE],
    // Sol sous les photos (LiDAR HD, sinon RGE ALTI) : vérification de la position RTK, sol au
    // point visé, inclinaison automatique
    ["IGN : altitudes du LiDAR HD",
      `${GEOPF}/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=4.55&lat=47.26&resource=ign_lidar_hd_mnt_mono_wld&zonly=true`],
    ["IGN : altitudes du RGE ALTI (secours du LiDAR HD)",
      `${GEOPF}/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=4.55&lat=47.26&resource=ign_rge_alti_wld&zonly=true`],
    ["IGN : BD TOPO (WFS)", `${GEOPF}/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:commune&COUNT=1`
      + "&PROPERTYNAME=nom_officiel&OUTPUTFORMAT=application/json"],
    ["IGN : recherche de lieux (géocodage)", `${GEOPF}/geocodage/completion?text=pouilly&maximumResponses=1`],
    // Grille du géoïde (altitude NGF : hauteur de caméra d'après le GPS), voir py/geoid.py ; ses 16 premiers octets
    // seulement (340 Ko en tout)
    ["PROJ : grille du géoïde (altitude NGF)", "https://cdn.proj.org/fr_ign_RAF20.tif", { headers: { Range: "bytes=0-15" } }],
  ];

  /** Vérifie un service ; voyant de la ligne (classe ok, echec, attente) et texte de son état. */
  async function checkService(list, name, url, init = {}) {
    const item = Object.assign(document.createElement("li"), { className: "attente" });
    const label = document.createElement("span");
    label.textContent = name;
    const state = Object.assign(document.createElement("span"), { className: "etat-service", textContent: "…" });
    item.append(label, state);
    list.append(item);
    // Un échec est réessayé une fois, 2 s plus tard : une réponse manquée en passant ne vaut pas un service bloqué
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let ok = false, text, title = "";
      try {
        const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });  // pas le cache (#23)
        ok = response.ok;
        text = ok ? "accessible" : `HTTP ${response.status}`;
      } catch (error) {
        text = error.name === "AbortError" ? "pas de réponse" : "bloqué";
        title = error.message;
      } finally {
        clearTimeout(timer);
      }
      if (ok || attempt === 1) {  // « attente » jusque-là : le bilan ne compte pas l'échec avant le nouvel essai
        item.className = ok ? "ok" : "echec";
        state.textContent = text;
        state.title = title;
        return;
      }
      state.textContent = `${text}, nouvel essai…`;
    }
  }

  /** Vérifie tous les services dans list ; done(accessibles, bloqués, total) à chaque réponse. */
  function checkServices(list, done = () => {}) {
    const count = () => done(list.querySelectorAll("li.ok").length, list.querySelectorAll("li.echec").length, SERVICES.length);
    for (const [name, url, init] of SERVICES) checkService(list, name, url, init).then(count);
  }

  /** Adresses possibles de la séquence de la photo dans l'API de son instance, la plus sûre
   * d'abord : son lien « collection » (sauf celui du méta-catalogue), le lien « via » vers son
   * instance d'origine (fiche du méta-catalogue), puis l'adresse de ses images (juste pour les
   * instances qui les servent elles-mêmes : celles de l'IGN sont sur un stockage OVH, qui
   * refuse l'API). */
  function sequenceApis(feature) {
    const links = feature?.links || [];
    const out = [];
    const link = links.find((l) => l.rel === "collection")?.href || "";
    if (link && !link.startsWith(PANORAMAX_API)) out.push(link.replace(/\/$/, ""));
    const sites = [links.find((l) => l.rel === "via")?.href, feature?.assets?.sd?.href || feature?.assets?.hd?.href];
    for (const href of sites) {
      try {
        out.push(`${new URL(href).origin}/api/collections/${encodeURIComponent(feature.collection)}`);
      } catch { /* adresse absente ou illisible */ }
    }
    return [...new Set(out)];
  }

  return { checkServices, sequenceApis };
})();
