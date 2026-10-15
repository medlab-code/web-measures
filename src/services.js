// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vérification des services appelés depuis le navigateur : un échec signale un proxy, un
// pare-feu ou un en-tête CORS manquant sur le poste.

const Services = (() => {
  const { GEOPF, OSM_TILES, PANORAMAX_API } = Carte;

  const SERVICES = [
    ["Panoramax : recherche de photos", `${PANORAMAX_API}/search?limit=1`],
    ["Panoramax : filaire (tuiles)", `${PANORAMAX_API}/map/14/8396/5876.mvt`],
    ["Panoramax : photos de l'IGN", "https://panoramax.ign.fr/api/search?limit=1"],
    ["IGN : fonds de carte (WMTS)", `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetCapabilities`],
    ["OpenStreetMap France : fond de carte", OSM_TILES.replace("{s}", "a").replace("{z}/{x}/{y}", "15/16846/11558")],
    ["IGN : altitudes (RGE ALTI, LiDAR HD)",
      `${GEOPF}/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=4.55&lat=47.26&resource=ign_rge_alti_wld&zonly=true`],
    ["IGN : MNS LiDAR HD (WMS)", `${GEOPF}/wms-r/wms?SERVICE=WMS&REQUEST=GetCapabilities`],
    ["IGN : BD TOPO et cadastre (WFS)", `${GEOPF}/wfs/ows?SERVICE=WFS&REQUEST=GetCapabilities`],
    ["IGN : recherche de lieux (géocodage)", `${GEOPF}/geocodage/completion?text=pouilly&maximumResponses=1`],
    ["geo.api.gouv.fr : commune de la photo", "https://geo.api.gouv.fr/communes?lat=47.26&lon=4.55&fields=nom"],
    ["Open-Meteo (secours)", "https://api.open-meteo.com/v1/elevation?latitude=47.26&longitude=4.55"],
  ];

  async function checkService(list, name, url) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = name;
    const state = document.createElement("span");
    state.className = "attente";
    state.textContent = "…";
    item.append(label, state);
    list.append(item);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      state.className = response.ok ? "ok" : "echec";
      state.textContent = response.ok ? "accessible" : `HTTP ${response.status}`;
    } catch (error) {
      state.className = "echec";
      state.textContent = error.name === "AbortError" ? "pas de réponse" : "bloqué";
      state.title = error.message;
    } finally {
      clearTimeout(timer);
    }
  }

  function checkServices(list) {
    for (const [name, url] of SERVICES) checkService(list, name, url);
  }

  return { checkServices };
})();
