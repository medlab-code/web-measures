// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Lieu de la photo affichée, incrusté dans la visionneuse : route (numéro et nom de la voie,
// tronçon de la BD TOPO le plus proche), point de repère (PR + distance, BD TOPO), hors route
// départementale la véloroute suivie (itinéraires cyclables de la BD TOPO) et l'écluse la plus
// proche (repère des chemins de halage), et commune
// (découpage administratif de geo.api.gouv.fr).

const Lieu = (() => {
  const WFS = "https://data.geopf.fr/wfs/ows";
  const COMMUNES = "https://geo.api.gouv.fr/communes";
  const REACH = 25;  // m : tronçons cherchés autour de la photo
  const SECTION_REACH = 40;  // m : section de PR de la route cherchée autour de la photo
  const cache = new Map();  // lieu déjà lu, au mètre près

  function local([lon, lat], [lon0, lat0]) {
    const k = Math.cos(lat0 * Math.PI / 180);
    return [(lon - lon0) * 111320 * k, (lat - lat0) * 111320];
  }

  /** Objets d'une couche de la BD TOPO : autour de (lon, lat) dans un rayon `reach`, ou selon
   * un filtre CQL (par pages : `count` objets à partir du rang `start`). */
  async function features(layer, { lon, lat, reach, filter, count = 50, start = 0, properties }) {
    const params = new URLSearchParams({
      SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: `BDTOPO_V3:${layer}`,
      OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: String(count),
    });
    if (start) params.set("STARTINDEX", String(start));
    if (properties) params.set("PROPERTYNAME", properties);  // attributs seuls, sans géométrie
    if (filter) {
      params.set("CQL_FILTER", filter);
    } else {
      const dlat = reach / 111320, dlon = reach / (111320 * Math.cos(lat * Math.PI / 180));
      params.set("BBOX", `${lat - dlat},${lon - dlon},${lat + dlat},${lon + dlon},urn:ogc:def:crs:EPSG::4326`);
    }
    const response = await fetch(`${WFS}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).features || [];
  }

  /** Longueur (m) du segment [a, b] en [lon, lat], à la latitude du segment. */
  function segmentLength(a, b) {
    const k = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
    return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 111320);
  }

  /** Projection du point (lon, lat) sur une ligne [[lon, lat]] : { d, s }, distance (m) à la
   * ligne et abscisse curviligne (m) depuis son début. L'abscisse cumule les segments mesurés
   * chacun à sa latitude : une section de PR fait des dizaines de kilomètres, et une seule
   * latitude pour toute la ligne la fausserait de dizaines de mètres. */
  function project(line, lon, lat) {
    const pts = line.map((p) => local(p, [lon, lat]));
    let best = null, along = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (len * len || 1)));
      const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
      const length = segmentLength(line[i - 1], line[i]);
      if (!best || d < best.d) best = { d, s: along + t * length };
      along += length;
    }
    return best || { d: Infinity, s: 0 };
  }

  /** Point de repère de la photo sur la route `numero` : « PR 4 +0185 », ou "". Le PR est le
   * dernier du filaire IGN passé le long de la section ; la distance est celle mesurée depuis
   * lui le long du filaire, sans mise à l'échelle : chaque PR du filaire fait foi (on passe de
   * PR 24 +0892 à PR 25 +0000), et l'écart entre deux PR peut dépasser 1 000 m. */
  async function milestone(numero, lon, lat) {
    if (!numero) return "";
    let section = null;
    for (const f of await features("section_de_points_de_repere", { lon, lat, reach: SECTION_REACH })) {
      if ((f.properties || {}).numero_de_route !== numero || f.geometry?.type !== "LineString") continue;
      const p = project(f.geometry.coordinates, lon, lat);
      if (p.d <= SECTION_REACH && (!section || p.d < section.p.d)) section = { f, p };
    }
    if (!section) return "";
    const line = section.f.geometry.coordinates;
    const id = section.f.properties.identifiant_de_section.replace(/'/g, "''");
    const prs = (await features("point_de_repere", { filter: `identifiant_de_section='${id}'`, count: 500 }))
      .filter((f) => /^\d+$/.test(String(f.properties?.numero)) && f.properties.abscisse != null)
      .map((f) => ({ n: Number(f.properties.numero), a: f.properties.abscisse,
        s: project(line, ...f.geometry.coordinates).s }))
      .sort((x, y) => x.a - y.a);
    if (!prs.length) return "";
    // Section tracée dans le sens des PR décroissants : abscisses curvilignes retournées
    let s = section.p.s;
    if (prs.length > 1 && prs[prs.length - 1].s < prs[0].s) {
      const total = project(line, ...line[line.length - 1]).s;
      for (const pr of prs) pr.s = total - pr.s;
      s = total - s;
    }
    let i = prs.findLastIndex((pr) => pr.s <= s);
    if (i < 0) i = 0;  // avant le premier PR de la section : distance négative
    const pr = prs[i];
    const m = Math.round(s - pr.s);
    return `PR ${pr.n} ${m < 0 ? "-" : "+"}${String(Math.abs(m)).padStart(4, "0")}`;
  }

  // Tronçons où ne roule pas le véhicule de prise de vue : un trottoir saisi en sentier peut
  // passer plus près de la photo que l'axe de la chaussée
  const NOT_DRIVEN = new Set(["Sentier", "Escalier", "Bac ou liaison maritime"]);

  /** Tronçon de route (praticable en voiture) le plus proche parmi troncons : { numero, nom } ou null. */
  function road(troncons, lon, lat) {
    let best = null;
    for (const feature of troncons) {
      if (NOT_DRIVEN.has(feature.properties?.nature)) continue;
      const geometry = feature.geometry || {};
      const lines = geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates || []];
      for (const line of lines) {
        const { d } = project(line, lon, lat);
        if (!best || d < best.d) best = { d, props: feature.properties || {} };
      }
    }
    if (!best) return null;
    const p = best.props;
    return { numero: p.cpx_numero || "", nom: p.nom_voie_ban_gauche || p.nom_voie_ban_droite || "" };
  }

  const CYCLE_REACH = 12;  // m : véloroute du tronçon le plus proche, à cette distance au plus
  const CYCLE = "Itinéraire cyclable";

  /** Véloroutes du tronçon le plus proche qui en porte (chemin, voie verte, route…) : leurs noms
   * (BD TOPO : natures et noms des itinéraires du tronçon, listes parallèles séparées par « / »),
   * sans les itinéraires de randonnée ; "" s'il n'y en a pas à CYCLE_REACH m. */
  function cycleRoutes(troncons, lon, lat) {
    let best = null;
    for (const feature of troncons) {
      const p = feature.properties || {};
      const natures = String(p.cpx_nature_itineraire_autre || "").split("/");
      const names = String(p.cpx_toponyme_itineraire_autre || "").split("/");
      const cycle = names.filter((name, k) => name.trim() && (natures.length === names.length ? natures[k] : natures[0]) === CYCLE);
      if (!cycle.length) continue;
      const geometry = feature.geometry || {};
      const lines = geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates || []];
      for (const line of lines) {
        const { d } = project(line, lon, lat);
        if (d <= CYCLE_REACH && (!best || d < best.d)) best = { d, cycle };
      }
    }
    return best ? [...new Set(best.cycle.map((n) => n.trim()))].join(" / ") : "";
  }

  const LOCK_REACH = 2000;  // m : écluse cherchée autour d'une photo prise sur une véloroute

  /** Écluse la plus proche (BD TOPO, constructions de nature « Ecluse »), repère le long des
   * véloroutes de chemin de halage : « écluse n° 22 de Marigny à 250 m », ou "" s'il n'y en a pas
   * à LOCK_REACH m. Distance à vol d'oiseau jusqu'au centre de l'écluse. */
  async function nearestLock(lon, lat) {
    let best = null;
    for (const f of await features("construction_surfacique", { lon, lat, reach: LOCK_REACH, count: 1000 })) {
      const p = f.properties || {};
      if (p.nature !== "Ecluse" || !p.toponyme) continue;
      const g = f.geometry || {};
      const ring = (g.type === "MultiPolygon" ? g.coordinates[0]?.[0] : g.coordinates?.[0]) || [];
      if (!ring.length) continue;
      const cx = ring.reduce((t, q) => t + q[0], 0) / ring.length, cy = ring.reduce((t, q) => t + q[1], 0) / ring.length;
      const [x, y] = local([cx, cy], [lon, lat]);
      const d = Math.hypot(x, y);
      if (d <= LOCK_REACH && (!best || d < best.d)) best = { d, name: p.toponyme };
    }
    if (!best) return "";
    const name = best.name.replace(/^Écluse Numéro\s*/i, "écluse n° ");
    return `${name} à ${best.d < 1000 ? `${Math.round(best.d / 10) * 10} m` : `${(best.d / 1000).toFixed(1).replace(".", ",")} km`}`;
  }

  /** Commune qui contient le point, ou "". */
  async function commune(lon, lat) {
    const response = await fetch(`${COMMUNES}?lat=${lat}&lon=${lon}&fields=nom&format=json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json())[0] || {}).nom || "";
  }

  /** « D16 – PR 27 +0185 – Place de la Liberation – Pouilly-en-Auxois » (parties connues) ; hors
   * route départementale, la véloroute suivie et l'écluse la plus proche avant la commune.
   * Retourne { text, complete } : complete faux si un service a échoué (la Géoplateforme refuse
   * des requêtes en rafale, HTTP 429) ; le texte, partiel, n'est alors pas gardé, à redemander. */
  async function describe(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (cache.has(key)) return { text: cache.get(key), complete: true };
    let failed = false;
    const fail = (value) => () => { failed = true; return value; };
    const [troncons, c] = await Promise.all([features("troncon_de_route", { lon, lat, reach: REACH }).catch(fail(null)),
      commune(lon, lat).catch(fail(""))]);
    const r = troncons ? road(troncons, lon, lat) : null;
    const pr = await milestone(r?.numero, lon, lat).catch(fail(""));
    // Hors route départementale : la véloroute suivie, s'il y en a une (chemin de halage, voie verte…)
    const bike = troncons && !/^D\d/.test(r?.numero || "") ? cycleRoutes(troncons, lon, lat) : "";
    const lock = bike ? await nearestLock(lon, lat).catch(fail("")) : "";  // repère des chemins de halage
    const text = [r?.numero, pr, r?.nom, bike, lock, c].filter(Boolean).join(" – ");  // comme l'étiquette de droite
    if (!failed && text) {
      cache.set(key, text);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return { text, complete: !failed };
  }

  return { describe, features, project, segmentLength };
})();
