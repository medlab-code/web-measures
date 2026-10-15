// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Lieu de la photo affichée, incrusté dans la visionneuse : route (numéro et nom de la voie,
// tronçon de la BD TOPO le plus proche) et commune (découpage administratif de geo.api.gouv.fr).

const Lieu = (() => {
  const WFS = "https://data.geopf.fr/wfs/ows";
  const COMMUNES = "https://geo.api.gouv.fr/communes";
  const REACH = 25;  // m : tronçons cherchés autour de la photo
  const cache = new Map();  // lieu déjà lu, au mètre près

  function local([lon, lat], [lon0, lat0]) {
    const k = Math.cos(lat0 * Math.PI / 180);
    return [(lon - lon0) * 111320 * k, (lat - lat0) * 111320];
  }

  /** Distance (m) du point (0, 0) au segment a-b, en coordonnées locales. */
  function toSegment(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(a[0] + t * dx, a[1] + t * dy);
  }

  /** Tronçon de route le plus proche : { numero, nom } ou null. */
  async function road(lon, lat) {
    const dlat = REACH / 111320, dlon = REACH / (111320 * Math.cos(lat * Math.PI / 180));
    const params = new URLSearchParams({
      SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: "BDTOPO_V3:troncon_de_route",
      OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: "50",
      BBOX: `${lat - dlat},${lon - dlon},${lat + dlat},${lon + dlon},urn:ogc:def:crs:EPSG::4326`,
    });
    const response = await fetch(`${WFS}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let best = null;
    for (const feature of (await response.json()).features || []) {
      const geometry = feature.geometry || {};
      const lines = geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates || []];
      for (const line of lines) {
        const pts = line.map((p) => local(p, [lon, lat]));
        for (let i = 1; i < pts.length; i++) {
          const d = toSegment(pts[i - 1], pts[i]);
          if (!best || d < best.d) best = { d, props: feature.properties || {} };
        }
      }
    }
    if (!best) return null;
    const p = best.props;
    return { numero: p.cpx_numero || "", nom: p.nom_voie_ban_gauche || p.nom_voie_ban_droite || "" };
  }

  /** Commune qui contient le point, ou "". */
  async function commune(lon, lat) {
    const response = await fetch(`${COMMUNES}?lat=${lat}&lon=${lon}&fields=nom&format=json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json())[0] || {}).nom || "";
  }

  /** « D16 · Place de la Liberation · Pouilly-en-Auxois » (parties connues seulement). */
  async function describe(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (!cache.has(key)) {
      const [r, c] = await Promise.all([road(lon, lat).catch(() => null), commune(lon, lat).catch(() => "")]);
      const text = [r?.numero, r?.nom, c].filter(Boolean).join(" · ");
      if (!text) return "";  // services injoignables : rien de gardé, on réessaiera
      cache.set(key, text);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }

  return { describe };
})();
