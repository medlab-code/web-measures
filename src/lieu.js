// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Lieu de la photo affichée, incrusté dans la visionneuse : route (numéro et nom de la voie,
// tronçon de la BD TOPO le plus proche), point de repère (PR + distance, BD TOPO), hors route
// départementale la véloroute suivie (itinéraires cyclables de la BD TOPO) et l'écluse la plus
// proche (repère des chemins de halage), hameau ou quartier (zone d'habitation de la BD TOPO
// contenant la photo) et commune (BD TOPO).

const Lieu = (() => {
  const WFS = "https://data.geopf.fr/wfs/ows";
  const REACH = 25;  // m : tronçons cherchés autour de la photo
  const SECTION_REACH = 40;  // m : section de PR de la route cherchée autour de la photo
  const cache = new Map();  // lieu déjà lu, au mètre près : { text, parts }
  // Tronçons et sections de PR lus par zone (maille de CELL degrés élargie de CELL_MARGIN m) et
  // gardés : les photos d'une séquence, à quelques mètres les unes des autres, n'envoient plus
  // de requête chacune (la Géoplateforme refuse les rafales, HTTP 429)
  const CELL = 0.004;  // degrés : ~300 × 440 m
  const CELL_MARGIN = 50;  // m, au moins REACH et SECTION_REACH
  const zones = new Map();  // couche et maille -> promesse des objets
  const prsBySection = new Map();  // identifiant de section -> promesse de ses PR
  // Requêtes WFS : au plus PARALLEL à la fois ; un refus (HTTP 429) est retenté après une pause
  const PARALLEL = 2;
  const RETRIES = [1000, 3000];  // ms
  const TIMEOUT = 30000;  // ms
  let running = 0;
  const waiting = [];

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
    const response = await queued(`${WFS}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).features || [];
  }

  /** fetch(url) dans la file des requêtes WFS (voir PARALLEL et RETRIES). */
  async function queued(url) {
    for (let attempt = 0; ; attempt++) {
      if (running >= PARALLEL) await new Promise((resolve) => waiting.push(resolve));
      running++;
      let response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });  // une requête bloquée occuperait la file
      } finally {
        running--;
        waiting.shift()?.();
      }
      if (response.status !== 429 || attempt >= RETRIES.length) return response;
      await new Promise((resolve) => setTimeout(resolve, RETRIES[attempt]));
    }
  }

  /** Objets d'une couche dans la maille de (lon, lat), élargie de margin m : lus une fois par
   * maille (un échec n'est pas gardé). */
  function zone(layer, properties, lon, lat, margin = CELL_MARGIN) {
    const i = Math.floor(lon / CELL), j = Math.floor(lat / CELL);
    const key = `${layer} ${i} ${j}`;
    if (!zones.has(key)) {
      const lat0 = (j + 0.5) * CELL;
      const mlat = margin / 111320, mlon = margin / (111320 * Math.cos(lat0 * Math.PI / 180));
      const box = [i * CELL - mlon, j * CELL - mlat, (i + 1) * CELL + mlon, (j + 1) * CELL + mlat];
      const params = new URLSearchParams({
        SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: `BDTOPO_V3:${layer}`,
        OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: "5000", PROPERTYNAME: properties,
        BBOX: `${box[1]},${box[0]},${box[3]},${box[2]},urn:ogc:def:crs:EPSG::4326`,
      });
      const promise = queued(`${WFS}?${params}`).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()).features || [];
      });
      promise.catch(() => zones.delete(key));  // à redemander
      zones.set(key, promise);
      if (zones.size > 200) zones.delete(zones.keys().next().value);
    }
    return zones.get(key);
  }

  /** Points de repère numérotés de la section, avec leur abscisse officielle : lus une fois par
   * section (un échec n'est pas gardé). */
  function sectionMilestones(id) {
    if (!prsBySection.has(id)) {
      const promise = features("point_de_repere", {
        filter: `identifiant_de_section='${id.replace(/'/g, "''")}'`, count: 500,
        properties: "numero,abscisse,geometrie",
      });
      promise.catch(() => prsBySection.delete(id));
      prsBySection.set(id, promise);
      if (prsBySection.size > 100) prsBySection.delete(prsBySection.keys().next().value);
    }
    return prsBySection.get(id);
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
    for (const f of await zone("section_de_points_de_repere", "numero_de_route,identifiant_de_section,geometrie", lon, lat)) {
      if ((f.properties || {}).numero_de_route !== numero || f.geometry?.type !== "LineString") continue;
      const p = project(f.geometry.coordinates, lon, lat);
      if (p.d <= SECTION_REACH && (!section || p.d < section.p.d)) section = { f, p };
    }
    if (!section) return "";
    const line = section.f.geometry.coordinates;
    const prs = (await sectionMilestones(section.f.properties.identifiant_de_section))
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
  // Attributs des tronçons lus (route, véloroutes), sans les autres : réponse six fois plus légère
  const TRONCON_PROPERTIES = "nature,cpx_numero,nom_voie_ban_gauche,nom_voie_ban_droite,position_par_rapport_au_sol,"
    + "cpx_nature_itineraire_autre,cpx_toponyme_itineraire_autre,geometrie";

  /** Tronçon de route (praticable en voiture) le plus proche parmi troncons : { numero, nom } ou null. */
  function road(troncons, lon, lat) {
    let best = null;
    for (const feature of troncons) {
      if (NOT_DRIVEN.has(feature.properties?.nature)) continue;
      const geometry = feature.geometry || {};
      const lines = geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates || []];
      for (const line of lines) {
        const { d } = project(line, lon, lat);
        if (d <= REACH && (!best || d < best.d)) best = { d, props: feature.properties || {} };
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

  /** Commune qui contient le point, ou "" : contours de la BD TOPO lus par maille, comme les routes
   * (une requête rapide pour toutes les photos voisines). */
  async function commune(lon, lat) {
    const communes = await zone("commune", "nom_officiel,geometrie", lon, lat);
    return communes.find((c) => inside(c.geometry, lon, lat))?.properties.nom_officiel || "";
  }

  /** « D16 – PR 27 +0185 – Place de la Liberation – Pouilly-en-Auxois » (parties connues) ; hors
   * route départementale, la véloroute suivie et l'écluse la plus proche avant la commune.
   * Retourne { text, complete, parts } : complete faux si un service a échoué (la Géoplateforme
   * refuse des requêtes en rafale, HTTP 429) ; le texte, partiel, n'est alors pas gardé, à
   * redemander. parts : { commune, voie (numéro, sinon nom), pr } (nom des favoris). */
  // Hameau ou quartier (zone d'habitation de la BD TOPO contenant la photo, ou la plus proche à
  // HAMLET_REACH m : ces zones suivent les bâtiments au plus près, l'entrée du hameau par la route
  // en reste souvent dehors), écrit avant la commune
  const HABITATION_PROPERTIES = "toponyme,nature,importance,geometrie";
  const HAMLET_REACH = 100;  // m
  const HABITATION_NATURES = ["Lieu-dit habité", "Quartier"];

  /** Le point (lon, lat) est-il dans la géométrie GeoJSON (Polygon ou MultiPolygon, trous compris) ? */
  function inside(geometry, lon, lat) {
    const ring = (r) => {  // lancer de rayon vers l'est
      let n = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) n = !n;
      }
      return n;
    };
    const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
    return polygons.some(([outer, ...holes]) => ring(outer) && !holes.some(ring));
  }

  /** Distance (m) de (lon, lat) à la géométrie GeoJSON (Polygon, MultiPolygon) : 0 dedans. */
  function distanceTo(geometry, lon, lat) {
    if (inside(geometry, lon, lat)) return 0;
    const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
    let best = Infinity;
    for (const ring of polygons.flat()) best = Math.min(best, project(ring, lon, lat).d);
    return best;
  }

  /** Nom du hameau ou du quartier où est (lon, lat), ou du plus proche à HAMLET_REACH m, sauf le bourg
   * qui porte le nom de la commune ; "" sinon. À égalité (zones emboîtées, dedans) : la plus petite
   * (importance la plus faible, nombre le plus grand). */
  function hamlet(zones, lon, lat, commune) {
    const same = (a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }) === 0;
    const found = zones.filter(({ properties: p }) => p.toponyme && HABITATION_NATURES.includes(p.nature)
      && !(commune && same(p.toponyme, commune)))
      .map((z) => ({ z, d: distanceTo(z.geometry, lon, lat) })).filter(({ d }) => d <= HAMLET_REACH);
    found.sort((a, b) => a.d - b.d || Number(b.z.properties.importance) - Number(a.z.properties.importance));
    return found[0]?.z.properties.toponyme || "";
  }

  async function describe(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (cache.has(key)) return { ...cache.get(key), complete: true };
    let failed = false;
    const fail = (value) => () => { failed = true; return value; };
    const [troncons, c, habitations] = await Promise.all([zone("troncon_de_route", TRONCON_PROPERTIES, lon, lat).catch(fail(null)),
      commune(lon, lat).catch(fail("")), zone("zone_d_habitation", HABITATION_PROPERTIES, lon, lat, HAMLET_REACH).catch(fail([]))]);
    const place = hamlet(habitations, lon, lat, c);
    const r = troncons ? road(troncons, lon, lat) : null;
    const pr = await milestone(r?.numero, lon, lat).catch(fail(""));
    // Hors route départementale : la véloroute suivie, s'il y en a une (chemin de halage, voie verte…)
    const bike = troncons && !/^D\d/.test(r?.numero || "") ? cycleRoutes(troncons, lon, lat) : "";
    const lock = bike ? await nearestLock(lon, lat).catch(fail("")) : "";  // repère des chemins de halage
    const text = [r?.numero, pr, r?.nom, bike, lock, place, c].filter(Boolean).join(" – ");  // comme l'étiquette de droite
    const parts = { lieudit: place, commune: c, voie: r?.numero || r?.nom || "", pr };
    if (!failed && text) {
      cache.set(key, { text, parts });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return { text, complete: !failed, parts };
  }

  /**
   * Carrefours le long des points lonlats ([lon, lat] du parcours) : extrémités communes à trois tronçons de route
   * revêtue ou plus (JUNCTION_ROADS) (BD TOPO, mailles gardées en cache comme pour describe) : [{ lonlat, branches }], branches :
   * cap (degrés) de chaque tronçon depuis le carrefour, pris à 10 m (ou à son autre bout s'il est plus court).
   */
  // Voies comptées dans les carrefours : routes revêtues, pas les chemins (de vigne, agricoles), pistes ni sentiers
  const JUNCTION_ROADS = new Set(["Route à 1 chaussée", "Route à 2 chaussées", "Rond-point", "Bretelle", "Type autoroutier"]);
  async function junctions(lonlats) {
    const cells = new Map();
    for (const [lon, lat] of lonlats) cells.set(`${Math.floor(lon / CELL)} ${Math.floor(lat / CELL)}`, [lon, lat]);
    const seen = new Set(), ends = new Map();
    const metres = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 111320);
    const heading = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
    for (const [lon, lat] of cells.values()) {
      for (const f of await zone("troncon_de_route", TRONCON_PROPERTIES, lon, lat)) {
        const id = f.id ?? JSON.stringify(f.geometry?.coordinates?.[0]);
        if (!JUNCTION_ROADS.has(f.properties?.nature) || seen.has(id)) continue;
        seen.add(id);
        const lines = f.geometry?.type === "LineString" ? [f.geometry.coordinates]
          : f.geometry?.type === "MultiLineString" ? f.geometry.coordinates : [];
        for (const line of lines) {
          if (line.length < 2) continue;
          for (const way of [line, [...line].reverse()]) {
            let k = 1;
            while (k < way.length - 1 && metres(way[0], way[k]) < 10) k++;
            const key = `${way[0][0].toFixed(6)} ${way[0][1].toFixed(6)}`;
            if (!ends.has(key)) ends.set(key, { lonlat: way[0].slice(0, 2), branches: [] });
            ends.get(key).branches.push(heading(way[0], way[k]));
          }
        }
      }
    }
    return [...ends.values()].filter((j) => j.branches.length >= 3);
  }

  /**
   * Ouvrages d'art le long des points lonlats ([lon, lat] du parcours) : tronçons de route hors du sol (BD TOPO,
   * position par rapport au sol autre que 0 : pont, passage supérieur, tunnel), quelle que soit leur nature, mailles en
   * cache comme pour junctions : [{ lonlat }], milieu de chaque tronçon (un pont est un tronçon à part), un par 20 m.
   */
  async function structures(lonlats) {
    const cells = new Map();
    for (const [lon, lat] of lonlats) cells.set(`${Math.floor(lon / CELL)} ${Math.floor(lat / CELL)}`, [lon, lat]);
    const metres = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 111320);
    const out = [];
    for (const [lon, lat] of cells.values()) {
      for (const f of await zone("troncon_de_route", TRONCON_PROPERTIES, lon, lat)) {
        if (!f.properties?.position_par_rapport_au_sol || f.properties.position_par_rapport_au_sol === "0") continue;
        const line = f.geometry?.type === "LineString" ? f.geometry.coordinates : f.geometry?.coordinates?.[0] || [];
        if (line.length < 2) continue;
        // Milieu du tronçon, le long de sa ligne
        const total = line.slice(1).reduce((sum, p, k) => sum + metres(line[k], p), 0);
        let walked = 0, mid = line[0];
        for (let k = 1; k < line.length; k++) {
          const d = metres(line[k - 1], line[k]);
          if (walked + d >= total / 2) {
            const u = d ? (total / 2 - walked) / d : 0;
            mid = [line[k - 1][0] + (line[k][0] - line[k - 1][0]) * u, line[k - 1][1] + (line[k][1] - line[k - 1][1]) * u];
            break;
          }
          walked += d;
        }
        if (!out.some((o) => metres(o.lonlat, mid) < 20)) out.push({ lonlat: mid });
      }
    }
    return out;
  }

  /**
   * Place du point (lon, lat) par rapport au tracé de la route numero (sections de PR de la BD TOPO, mailles en cache) :
   * { d, gap } ; d : distance (m), Infinity si elle ne passe pas par là (ou n'a pas de PR) ; gap : la route s'interrompt
   * ici (tronc commun avec une autre, souvent de catégorie supérieure ; elle reprend plus loin) : point le plus proche au
   * bout d'une section, sans autre section de la route à GAP_JOIN m de ce bout (une route est coupée en sections
   * bout à bout, à chaque changement de côté par exemple), ou route absente.
   */
  async function roadPlace(numero, lon, lat) {
    const lines = (await zone("section_de_points_de_repere", "numero_de_route,identifiant_de_section,geometrie", lon, lat))
      .filter((f) => f.properties?.numero_de_route === numero && f.geometry?.type === "LineString").map((f) => f.geometry.coordinates);
    let best = null;
    for (const line of lines) {
      const p = project(line, lon, lat);
      if (!best || p.d < best.p.d) best = { line, p };
    }
    if (!best) return { d: Infinity, gap: true };
    const { line, p } = best, total = project(line, ...line[line.length - 1]).s;
    const tip = p.s < 1 ? line[0] : p.s > total - 1 ? line[line.length - 1] : null;
    const gap = Boolean(tip) && !lines.some((other) => other !== line
      && [other[0], other[other.length - 1]].some((q) => segmentLength(q, tip) < GAP_JOIN));
    return { d: p.d, gap };
  }
  const GAP_JOIN = 30;  // m : sections de la même route qui se suivent (pas une interruption)
  const roadDistance = async (numero, lon, lat) => (await roadPlace(numero, lon, lat)).d;

  /**
   * Tracé de la route numero de a à b ([lon, lat], sur elle ou tout près) : ses sections de PR de la BD TOPO dans
   * l'emprise des deux points (élargie de LINE_MARGIN m), enchaînées par le plus court chemin (bouts de sections à
   * GAP_JOIN m : simple découpage ; plus loin, LINE_GAP m au plus : interruption de la route, tronc commun, franchie en
   * ligne droite et comptée trois fois plus longue). Rend [[lon, lat]…] de a à b, ou null (route introuvable, a ou b
   * à plus de LINE_REACH m d'elle, ou sans chemin).
   */
  async function roadLine(numero, a, b) {
    const m = LINE_MARGIN / 111320, k = Math.cos(a[1] * Math.PI / 180);
    const box = [Math.min(a[1], b[1]) - m, Math.min(a[0], b[0]) - m / k, Math.max(a[1], b[1]) + m, Math.max(a[0], b[0]) + m / k];
    const lines = (await features("section_de_points_de_repere", { count: 500, properties: "numero_de_route,geometrie",
      filter: `numero_de_route='${numero.replace(/'/g, "''")}' AND BBOX(geometrie,${box.join(",")})` }))
      .filter((f) => f.geometry?.type === "LineString" && f.geometry.coordinates.length > 1).map((f) => f.geometry.coordinates.map((p) => p.slice(0, 2)));
    if (!lines.length) return null;
    // Point sur la route : section la plus proche et abscisse ; coupe d'une section entre deux abscisses
    const onto = (p) => lines.map((line, i) => ({ i, ...project(line, ...p) })).sort((x, y) => x.d - y.d)[0];
    const cut = (line, s0, s1) => {
      const out = [];
      let along = 0;
      const at = (s) => {
        let walked = 0;
        for (let k = 1; k < line.length; k++) {
          const d = segmentLength(line[k - 1], line[k]);
          if (walked + d >= s) {
            const u = d ? (s - walked) / d : 0;
            return [line[k - 1][0] + (line[k][0] - line[k - 1][0]) * u, line[k - 1][1] + (line[k][1] - line[k - 1][1]) * u];
          }
          walked += d;
        }
        return line[line.length - 1];
      };
      const [lo, hi] = s0 < s1 ? [s0, s1] : [s1, s0];
      out.push(at(lo));
      for (let k = 0; k < line.length; k++) {
        if (k) along += segmentLength(line[k - 1], line[k]);
        if (along > lo && along < hi) out.push(line[k]);
      }
      out.push(at(hi));
      return s0 < s1 ? out : out.reverse();
    };
    const pa = onto(a), pb = onto(b);
    if (pa.d > LINE_REACH || pb.d > LINE_REACH) return null;
    // Graphe : nœuds = bouts des sections (2i, 2i + 1), plus a (n) et b (n + 1)
    const n = 2 * lines.length, lengths = lines.map((line) => project(line, ...line[line.length - 1]).s);
    const tip = (v) => (v === n ? a : v === n + 1 ? b : lines[v >> 1][v % 2 ? lines[v >> 1].length - 1 : 0]);
    const edges = Array.from({ length: n + 2 }, () => []);
    const link = (u, v, w, how) => { edges[u].push({ v, w, how }); edges[v].push({ v: u, w, how }); };
    lines.forEach((_, i) => link(2 * i, 2 * i + 1, lengths[i], { i }));
    for (let u = 0; u < n; u++) {
      for (let v = u + 1; v < n; v++) {
        if ((u >> 1) === (v >> 1)) continue;
        const d = segmentLength(tip(u), tip(v));
        if (d < GAP_JOIN) link(u, v, d, { join: true });
        else if (d < LINE_GAP) link(u, v, 3 * d, { join: true });
      }
    }
    for (const [node, p] of [[n, pa], [n + 1, pb]]) {
      link(node, 2 * p.i, p.s, { i: p.i, from: p.s });
      link(node, 2 * p.i + 1, lengths[p.i] - p.s, { i: p.i, from: p.s });
    }
    if (pa.i === pb.i) link(n, n + 1, Math.abs(pa.s - pb.s), { i: pa.i, from: pa.s, to: pb.s });
    // Plus court chemin de a à b (Dijkstra, peu de nœuds)
    const dist = Array(n + 2).fill(Infinity), prev = Array(n + 2).fill(null), done = new Set();
    dist[n] = 0;
    for (;;) {
      let u = -1;
      for (let v = 0; v < n + 2; v++) if (!done.has(v) && dist[v] < Infinity && (u < 0 || dist[v] < dist[u])) u = v;
      if (u < 0 || u === n + 1) break;
      done.add(u);
      for (const e of edges[u]) {
        if (dist[u] + e.w < dist[e.v]) {
          dist[e.v] = dist[u] + e.w;
          prev[e.v] = { u, how: e.how };
        }
      }
    }
    if (dist[n + 1] === Infinity) return null;
    // Morceaux du chemin, de b vers a, puis remis dans l'ordre
    const pieces = [];
    for (let v = n + 1; prev[v]; v = prev[v].u) {
      const { u, how } = prev[v];
      if (how.join) pieces.push([tip(u), tip(v)]);
      else {
        const line = lines[how.i];
        const sOf = (node) => (node === n ? pa.s : node === n + 1 ? pb.s : node % 2 ? lengths[how.i] : 0);
        pieces.push(cut(line, sOf(u), sOf(v)));
      }
    }
    return pieces.reverse().flat();
  }
  const LINE_MARGIN = 1500, LINE_GAP = 3000, LINE_REACH = 40;  // m

  return { describe, features, junctions, milestone, project, roadDistance, roadLine, roadPlace, segmentLength, structures };
})();
