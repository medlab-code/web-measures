// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Couche importée (GeoJSON) : lecture, coordonnées en WGS 84 (Lambert 93 converti), couleur selon
// une colonne (une couleur par valeur, ou dégradé pour une colonne numérique) et étiquette d'une
// colonne. Dessinée sur la mini-carte (Carte.showOverlay) et, projetée au sol, dans la visionneuse
// (web_app.App.overlay_marks).

const Couche = (() => {
  const SINGLE = "#ff00ff";  // couleur unique : magenta, distinct des repères de l'application
  const EMPTY = "#9e9e9e";  // valeur vide, ou au-delà des valeurs distinctes
  // Une couleur par valeur : lisibles sur la photo comme sur l'orthophoto
  const PALETTE = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6",
    "#bcf60c", "#fabebe"];
  const RAMP = ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"];  // dégradé : 5 classes
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
   * GeoJSON (texte) lu : { features (WGS 84, géométrie non vide), columns (noms des attributs), crs }.
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
    const convert = crs === "lambert93" ? lambert93 : ([x, y]) => [x, y];  // z ignoré : objets posés au sol
    const out = features.map((f, i) => ({
      type: "Feature", id: i, properties: { ...(f.properties || {}) },
      geometry: { type: f.geometry.type, coordinates: mapCoords(f.geometry.coordinates, convert) },
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

  /**
   * Couleurs selon la colonne column ("" : couleur unique) : chaque objet reçoit properties._couleur
   * (et _etiquette selon labelColumn). Retourne la légende [{ couleur, texte }].
   */
  function style(features, column, labelColumn) {
    for (const f of features) f.properties._etiquette = labelColumn ? format(f.properties[labelColumn]) : "";
    if (!column) {
      for (const f of features) f.properties._couleur = SINGLE;
      return [{ couleur: SINGLE, texte: "tous les objets" }];
    }
    const values = features.map((f) => f.properties[column]).filter((v) => !isEmpty(v));
    const distinct = [...new Set(values.map(String))];
    const numbers = values.map(asNumber);
    const numeric = values.length && numbers.every(Number.isFinite) && distinct.length >= NUMERIC_MIN;
    const legend = [];
    if (numeric) {  // dégradé en classes égales du minimum au maximum
      const min = Math.min(...numbers), max = Math.max(...numbers), step = (max - min) / RAMP.length || 1;
      for (const f of features) {
        const v = asNumber(f.properties[column]);
        f.properties._couleur = isEmpty(f.properties[column]) || !Number.isFinite(v) ? EMPTY
          : RAMP[Math.min(RAMP.length - 1, Math.floor((v - min) / step))];
      }
      RAMP.forEach((couleur, k) => legend.push({ couleur, texte: `${format(min + k * step)} à ${format(min + (k + 1) * step)}` }));
    } else {  // une couleur par valeur, les plus fréquentes d'abord
      const count = new Map();
      for (const v of values) count.set(String(v), (count.get(String(v)) || 0) + 1);
      const ranked = [...count.keys()].sort((a, b) => count.get(b) - count.get(a));
      const colorOf = new Map(ranked.slice(0, PALETTE.length).map((v, k) => [v, PALETTE[k]]));
      for (const f of features) {
        const v = f.properties[column];
        f.properties._couleur = isEmpty(v) ? EMPTY : colorOf.get(String(v)) || EMPTY;
      }
      for (const [v, couleur] of colorOf) legend.push({ couleur, texte: format(v) });
      if (ranked.length > PALETTE.length) legend.push({ couleur: EMPTY, texte: `${ranked.length - PALETTE.length} autres valeurs` });
    }
    if (values.length < features.length) legend.push({ couleur: EMPTY, texte: "vide" });
    return legend;
  }

  return { read, style, format, lambert93 };
})();
