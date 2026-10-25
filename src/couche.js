// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Couche importée (GeoJSON, Shapefile, GeoPackage) : lecture, coordonnées en WGS 84 (Lambert 93
// converti, Shapefile reprojeté d'après son .prj), couleur selon une colonne (une couleur par valeur, ou dégradé pour une colonne numérique) et étiquette d'une
// colonne. Dessinée sur la mini-carte (Carte.showOverlay) et dans la visionneuse, à son altitude ou
// posée sur le sol LiDAR HD (web_app.App.overlay_marks).

const Couche = (() => {
  const SINGLE = "#ff00ff";  // couleur unique : magenta, distinct des repères de l'application
  const EMPTY = "#9e9e9e";  // valeur vide, ou au-delà des valeurs distinctes
  // Une couleur par valeur : palette Set1 de ColorBrewer, vive et faite pour que ses couleurs se
  // distinguent bien, sans son gris (celui des valeurs vides)
  const PALETTE = ["#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00", "#ffff33", "#a65628", "#f781bf"];
  const RAMP = ["#ffffb2", "#bd0026"];  // dégradé : couleurs du minimum et du maximum, à choisir dans la légende
  const NUMERIC_MIN = 11;  // valeurs distinctes au moins pour un dégradé (sinon une couleur par valeur)

  /** Lambert 93 (RGF93, EPSG:2154) vers longitude, latitude en degrés (IGN, ALG0004 ; RGF93 ≈ WGS 84). */
  function lambert93([x, y]) {
    const n = 0.7256077650532670, c = 11754255.426096, xs = 700000, ys = 12655612.049876, e = 0.0818191910428158;
    const dx = x - xs, dy = y - ys, r = Math.hypot(dx, dy);
    const lon = 3 + Math.atan(dx / -dy) / n * 180 / Math.PI;
    const l = -Math.log(r / c) / n;
    let lat = 2 * Math.atan(Math.exp(l)) - Math.PI / 2;
    for (let i = 0; i < 20; i++) {
      const s = e * Math.sin(lat);
      const next = 2 * Math.atan(((1 + s) / (1 - s)) ** (e / 2) * Math.exp(l)) - Math.PI / 2;
      if (Math.abs(next - lat) < 1e-12) { lat = next; break; }
      lat = next;
    }
    return [lon, lat * 180 / Math.PI];
  }

  /** Système de coordonnées du GeoJSON : "wgs84" ou "lambert93" ; erreur pour un autre. */
  function crsOf(data, first) {
    const name = String(data.crs?.properties?.name || "");
    if (/2154/.test(name)) return "lambert93";
    if (/4326|CRS84/.test(name) || !name) {
      if (!first || (Math.abs(first[0]) <= 180 && Math.abs(first[1]) <= 90)) return "wgs84";
      // Sans déclaration, des coordonnées en mètres de la France métropolitaine : Lambert 93
      if (first[0] > 0 && first[0] < 1.3e6 && first[1] > 6e6 && first[1] < 7.2e6) return "lambert93";
    }
    throw new Error(`système de coordonnées non pris en charge (${name || "coordonnées en mètres inconnues"}) : WGS 84 ou Lambert 93`);
  }

  /** Coordonnées d'une géométrie converties par f (positions imbriquées à toute profondeur). */
  function mapCoords(coords, f) {
    return typeof coords[0] === "number" ? f(coords) : coords.map((c) => mapCoords(c, f));
  }

  /**
   * Recalages d'un objet dans les photos, membre « recalages » de son Feature (hors attributs, ignoré
   * par QGIS) : { identifiant de photo: { decalage: [cap, élévation] (radians), position: [lon, lat]
   * de la photo, sequence } } ; fichier venu d'ailleurs : seuls les identifiants de photo et les
   * valeurs de la bonne forme sont gardés. undefined s'il n'y en a pas.
   */
  function recalages(value) {
    if (!value || typeof value !== "object") return undefined;
    const pair = (v, max) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Math.abs(x) <= max);
    const kept = Object.entries(value)
      .filter(([id, r]) => /^[0-9a-f-]{36}$/i.test(id) && pair(r?.decalage, 2 * Math.PI))
      .map(([id, r]) => [id, { decalage: r.decalage, ...(pair(r.position, 180) && { position: r.position }),
        ...(/^[0-9a-f-]{36}$/i.test(r.sequence) && { sequence: r.sequence }) }]);
    return kept.length ? Object.fromEntries(kept) : undefined;
  }

  /**
   * GeoJSON (texte) lu : { features (WGS 84, géométrie non vide, recalages gardés), columns (noms des
   * attributs), crs }.
   * GeometryCollection ignorées.
   */
  function read(text) {
    const data = JSON.parse(text);
    const all = data.type === "FeatureCollection" ? data.features || [] : data.type === "Feature" ? [data] : [];
    const features = all.filter((f) => f?.geometry?.coordinates && f.geometry.type !== "GeometryCollection");
    if (!features.length) throw new Error("aucun objet avec une géométrie");
    const firstOf = (c) => (typeof c[0] === "number" ? c : firstOf(c[0]));
    const first = firstOf(features[0].geometry.coordinates);
    const crs = crsOf(data, first);
    // Altitude z gardée (NGF) : l'objet y est dessiné ; sans elle, posé sur le sol LiDAR HD
    const keepZ = (xy, z) => (Number.isFinite(z) ? [...xy, z] : xy);
    const convert = crs === "lambert93" ? ([x, y, z]) => keepZ(lambert93([x, y]), z) : ([x, y, z]) => keepZ([x, y], z);
    const out = features.map((f, i) => ({
      type: "Feature", id: i, properties: { ...(f.properties || {}) },
      geometry: { type: f.geometry.type, coordinates: mapCoords(f.geometry.coordinates, convert) },
      ...(recalages(f.recalages) && { recalages: recalages(f.recalages) }),
    }));
    const columns = [...new Set(out.flatMap((f) => Object.keys(f.properties)))];
    return { features: out, columns, crs };
  }

  const isEmpty = (v) => v === null || v === undefined || v === "";
  const asNumber = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN);

  /** Texte d'une valeur pour une étiquette : nombre à la française (2 décimales au plus). */
  function format(value) {
    if (isEmpty(value)) return "";
    return typeof value === "number" ? value.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : String(value);
  }

  // Palette proposée au clic sur une pastille de la légende
  const CHOICES = [...PALETTE, SINGLE, "#800000", "#008080", "#000000", "#ffffff", EMPTY];

  /** Texte d'une étiquette d'un objet de couleur c (#rrggbb) : éclaircie de moitié (moitié de blanc). */
  function clair(c) {
    return `#${[1, 3, 5].map((i) => Math.round((parseInt(c.slice(i, i + 2), 16) + 255) / 2).toString(16).padStart(2, "0")).join("")}`;
  }

  /** Couleur entre a et b (#rrggbb), t de 0 (a) à 1 (b). */
  function mix(a, b, t) {
    return `#${[1, 3, 5].map((i) => {
      const [x, y] = [a, b].map((c) => parseInt(c.slice(i, i + 2), 16));
      return Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
    }).join("")}`;
  }

  /**
   * Couleurs selon la colonne column ("" : couleur unique) : chaque objet reçoit properties._couleur
   * (et _etiquette selon labelColumn). custom : couleurs choisies, par clé d'entrée de légende.
   * Retourne la légende [{ cle, couleur, texte }] ; degrade : vrai pour une colonne numérique d'au moins
   * NUMERIC_MIN valeurs, chaque objet y prenant le mélange des couleurs du minimum et du maximum
   * pondéré par sa valeur.
   */
  function style(features, column, labelColumn, custom = {}) {
    for (const f of features) f.properties._etiquette = labelColumn ? format(f.properties[labelColumn]) : "";
    let keyOf;  // objet → clé de son entrée de légende
    let ramp = null;  // dégradé : objet → couleur (null : vide)
    const legend = [];
    const values = column ? features.map((f) => f.properties[column]).filter((v) => !isEmpty(v)) : [];
    const distinct = [...new Set(values.map(String))];
    const numbers = values.map(asNumber);
    if (!column) {
      keyOf = () => "tous";
      legend.push({ cle: "tous", couleur: SINGLE, texte: "tous les objets" });
    } else if (values.length && numbers.every(Number.isFinite) && distinct.length >= NUMERIC_MIN) {
      // dégradé : mélange des couleurs du minimum et du maximum, pondéré par la valeur
      const min = Math.min(...numbers), max = Math.max(...numbers);
      const [low, high] = [custom.min || RAMP[0], custom.max || RAMP[1]];
      keyOf = () => "vide";
      ramp = (f) => {
        const v = asNumber(f.properties[column]);
        return isEmpty(f.properties[column]) || !Number.isFinite(v) ? null : mix(low, high, max > min ? (v - min) / (max - min) : 0);
      };
      legend.push({ cle: "min", couleur: low, texte: `${format(min)} (minimum)` },
        { cle: "max", couleur: high, texte: `${format(max)} (maximum)` });
    } else {  // une couleur par valeur, les plus fréquentes d'abord
      const count = new Map();
      for (const v of values) count.set(String(v), (count.get(String(v)) || 0) + 1);
      const ranked = [...count.keys()].sort((a, b) => count.get(b) - count.get(a));
      const shown = new Set(ranked.slice(0, PALETTE.length));
      keyOf = (f) => {
        const v = f.properties[column];
        return isEmpty(v) ? "vide" : shown.has(String(v)) ? `= ${v}` : "autres";
      };
      [...shown].forEach((v, k) => legend.push({ cle: `= ${v}`, couleur: PALETTE[k], texte: format(v) }));
      if (ranked.length > PALETTE.length) legend.push({ cle: "autres", couleur: EMPTY, texte: `${ranked.length - PALETTE.length} autres valeurs` });
    }
    if (values.length < features.length && column) legend.push({ cle: "vide", couleur: EMPTY, texte: "vide" });
    for (const e of legend) e.couleur = custom[e.cle] || e.couleur;
    const colorOf = new Map(legend.map((e) => [e.cle, e.couleur]));
    for (const f of features) f.properties._couleur = ramp?.(f) || colorOf.get(keyOf(f)) || EMPTY;
    legend.degrade = Boolean(ramp);
    return legend;
  }

  // Shapefile et GeoPackage : bibliothèques chargées au premier import de ce format (jsDelivr)
  const SHPJS = "https://cdn.jsdelivr.net/npm/shpjs@6.1.0/dist/shp.min.js";
  const SQLJS = "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/";
  const loaded = new Map();
  function script(url) {
    if (!loaded.has(url)) {
      loaded.set(url, new Promise((resolve, reject) => {
        const el = Object.assign(document.createElement("script"), { src: url, onload: resolve });
        el.onerror = () => { loaded.delete(url); reject(new Error(`bibliothèque non chargée (${url})`)); };
        document.head.append(el);
      }));
    }
    return loaded.get(url);
  }

  /**
   * Fichiers choisis lus en couche : { name, ...read } (voir read). GeoJSON ; Shapefile en .zip, ou
   * .shp avec .dbf (et .prj, .cpg) choisis ensemble, reprojeté en WGS 84 d'après le .prj (sans lui :
   * Lambert 93 reconnu à ses coordonnées) ; GeoPackage (.gpkg), table choisie par chooseTable(noms)
   * s'il en a plusieurs.
   */
  async function readFiles(files, chooseTable = (names) => names[0]) {
    const byExt = new Map([...files].map((f) => [f.name.toLowerCase().split(".").pop(), f]));
    if (byExt.has("gpkg")) return readGeoPackage(byExt.get("gpkg"), chooseTable);
    if (byExt.has("zip") || byExt.has("shp")) {
      await script(SHPJS);
      let data;
      if (byExt.has("zip")) {
        data = await shp(await byExt.get("zip").arrayBuffer());
      } else {
        if (!byExt.has("dbf")) throw new Error("choisir le .shp avec son .dbf (et son .prj)");
        const text = async (ext) => (byExt.has(ext) ? byExt.get(ext).text() : undefined);
        data = shp.combine([await shp.parseShp(await byExt.get("shp").arrayBuffer(), await text("prj")),
          await shp.parseDbf(await byExt.get("dbf").arrayBuffer(), await text("cpg"))]);
      }
      if (Array.isArray(data)) data = data[0];  // zip de plusieurs couches : la première
      const main = byExt.get("zip") || byExt.get("shp");
      return { name: main.name, ...read(JSON.stringify(data)) };
    }
    const file = byExt.get("geojson") || byExt.get("json") || files[0];
    return { name: file.name, ...read(await file.text()) };
  }

  /** GeoPackage : table de géométries choisie, en WGS 84 ou Lambert 93 (code EPSG de la table). */
  async function readGeoPackage(file, chooseTable) {
    await script(`${SQLJS}sql-wasm.js`);
    const SQL = await initSqlJs({ locateFile: (f) => `${SQLJS}${f}` });
    const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
    try {
      const rows = (sql) => {
        const [res] = db.exec(sql);
        return res ? res.values.map((v) => Object.fromEntries(res.columns.map((c, k) => [c, v[k]]))) : [];
      };
      const tables = rows("SELECT g.table_name, g.column_name, g.srs_id, s.organization, s.organization_coordsys_id "
        + "FROM gpkg_geometry_columns g LEFT JOIN gpkg_spatial_ref_sys s ON s.srs_id = g.srs_id");
      if (!tables.length) throw new Error("aucune table de géométries dans ce GeoPackage");
      const name = chooseTable(tables.map((t) => t.table_name));
      const table = tables.find((t) => t.table_name === name);
      if (!table) throw new Error("aucune table choisie");
      const epsg = String(table.organization || "").toUpperCase() === "EPSG" ? table.organization_coordsys_id : table.srs_id;
      const quote = (id) => `"${String(id).replace(/"/g, '""')}"`;
      const features = rows(`SELECT * FROM ${quote(table.table_name)}`).map((row) => {
        const { [table.column_name]: blob, ...rest } = row;
        const properties = Object.fromEntries(Object.entries(rest).filter(([, v]) => !(v instanceof Uint8Array)));  // sans les blobs
        return { type: "Feature", properties, geometry: blob ? gpkgGeometry(blob) : null };
      });
      const crs = { type: "name", properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` } };
      return { name: `${file.name} (${table.table_name})`, ...read(JSON.stringify({ type: "FeatureCollection", crs, features })) };
    } finally {
      db.close();
    }
  }

  /** Géométrie GeoJSON d'une géométrie de GeoPackage (en-tête « GP », enveloppe, puis WKB), ou null. */
  function gpkgGeometry(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== 0x47 || view.getUint8(1) !== 0x50) return null;  // « GP »
    const flags = view.getUint8(3);
    if (flags & 0x10) return null;  // géométrie vide
    const envelope = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0;
    return wkb(view, 8 + envelope).geometry;
  }

  /** Géométrie WKB (standard, ISO ou étendu : Z et M) à l'octet offset : { geometry, end }. */
  function wkb(view, offset) {
    const little = view.getUint8(offset) === 1;
    let code = view.getUint32(offset + 1, little), pos = offset + 5;
    let z = false, m = false;
    if (code & 0x80000000) z = true;  // EWKB
    if (code & 0x40000000) m = true;
    code &= 0x0fffffff;
    if (code >= 3000) { z = true; m = true; code -= 3000; } else if (code >= 2000) { m = true; code -= 2000; } else if (code >= 1000) { z = true; code -= 1000; }
    const dims = 2 + z + m;
    const point = () => {
      const p = [view.getFloat64(pos, little), view.getFloat64(pos + 8, little)];
      if (z) p.push(view.getFloat64(pos + 16, little));
      pos += 8 * dims;
      return p;
    };
    const count = () => { const n = view.getUint32(pos, little); pos += 4; return n; };
    const many = (f) => Array.from({ length: count() }, f);
    const sub = () => { const r = wkb(view, pos); pos = r.end; return r.geometry.coordinates; };
    const types = { 1: ["Point", point], 2: ["LineString", () => many(point)], 3: ["Polygon", () => many(() => many(point))],
      4: ["MultiPoint", () => many(sub)], 5: ["MultiLineString", () => many(sub)], 6: ["MultiPolygon", () => many(sub)] };
    if (!types[code]) throw new Error(`type de géométrie WKB non pris en charge (${code})`);
    const [type, f] = types[code];
    const coordinates = f();
    return { geometry: { type, coordinates }, end: pos };
  }

  return { read, readFiles, style, format, lambert93, clair, CHOICES };
})();
