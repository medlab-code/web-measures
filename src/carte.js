// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Carte : fonds IGN, filaire Panoramax (même style que le plugin QGIS), mesures, visées,
// curseur de vue, photo la plus proche d'un clic, filtre des photos, instance Panoramax.

const Carte = (() => {
  const META_API = "https://api.panoramax.xyz/api";
  const GEOPF = "https://data.geopf.fr";
  const ORANGE = "#ff6f00";
  const ROUGE = "#e53935";  // trait d'une mesure, visées : comme dans le plugin
  const JAUNE = "#ffeb00";  // points cliqués
  const BLEU = "#00bce6";  // largeur perpendiculaire : trait tracé perpendiculairement à la route
  const CURSEUR = "#0078ff";  // curseur de vue
  const VERT_PR = "#2e7d32";  // points de repère (PR) des routes

  let apiUrl = META_API;  // instance courante (voir setInstance)
  const tilesUrl = () => `${apiUrl}/map/{z}/{x}/{y}.mvt`;

  function wmts(layer, format) {
    return `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal` +
      `&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  }

  const ATTRIBUTION_IGN = '<a href="https://www.ign.fr">IGN</a>';
  const ATTRIBUTION_OSM = '© <a href="https://www.openstreetmap.org/copyright">les contributeurs d\'OpenStreetMap</a>, '
    + 'fond <a href="https://www.openstreetmap.fr">OpenStreetMap France</a>';
  // Tuiles d'OpenStreetMap France : le serveur officiel (tile.openstreetmap.org) refuse les
  // demandes sans page d'origine, celles de la page ouverte par double-clic (file://)
  const OSM_TILES = "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png";
  const osmTiles = ["a", "b", "c"].map((sub) => OSM_TILES.replace("{s}", sub));
  const BACKGROUNDS = ["plan", "ortho", "noms", "express", "pcrs", "osm"];
  // Limites administratives (ADMIN EXPRESS de l'IGN, par le WFS) : chaque niveau à partir d'un
  // zoom ; géométries de petite échelle vues de loin, plus précises de près (communes : celles de
  // la BD TOPO, pour savoir de quel côté d'une limite tombe une mesure)
  const ADMIN_LEVELS = [  // du plus fin au plus large : le plus large est dessiné par-dessus ;
    // départements : bleu du logo du Département de la Côte-d'Or ; communes : noir, en tirets (à
    // ne pas confondre avec le filaire des voies)
    { id: "communes", layer: "commune", minzoom: 11, paint: { "line-color": "#000000", "line-width": 1.2, "line-dasharray": [4, 2.5] } },
    // métropoles (EPCI de nature « Métropole ») : vert, un peu plus fin que les départements,
    // dès l'échelle du département
    { id: "metropoles", layer: "epci", minzoom: 7, properties: "cleabs,nom_officiel,nature,geometrie",
      filter: ["==", ["get", "nature"], "Métropole"], paint: { "line-color": "#16a34a", "line-width": 4 } },
    { id: "departements", layer: "departement", minzoom: 0, paint: { "line-color": "#0082c5", "line-width": 5 } },
  ];
  /** Épaisseur d'un contour (plus `extra` pour le liseré) : 40 % au zoom 5, entière dès le 10. */
  const adminWidth = (level, extra) => {
    const w = level.paint["line-width"];
    return ["interpolate", ["linear"], ["zoom"], 5, w * 0.4 + extra * 0.6, 10, w + extra];
  };
  const ADMIN_NEAR_ZOOM = 12;
  const adminDataset = (level, zoom) => (zoom < ADMIN_NEAR_ZOOM ? "ADMINEXPRESS-COG-CARTO-PE.LATEST"
    : level.layer === "commune" ? "ADMINEXPRESS-COG.LATEST" : "ADMINEXPRESS-COG-CARTO.LATEST");
  // Filaire des voies : tronçons de route de la BD TOPO (tuiles vectorielles de l'IGN, à partir du
  // zoom 15), couleur selon le réseau, numéros dans des cartouches dessinés comme ceux de l'IISR
  // (5e partie, annexe 24 ; routes métropolitaines : arrêté de 2018) : fond rouge pour les
  // autoroutes et nationales, jaune pour les départementales, cyan pour les métropolitaines, blanc
  // à listel noir pour les communales et chemins ruraux, vert pour les itinéraires européens ;
  // caractères blancs sur fond foncé, noirs sur fond clair ; suffixe en minuscule italique
  // Routes numérotées : tracé du Plan IGN vectoriel (couche des numéros de route : une ligne par
  // route, un seul trait pour deux chaussées séparées), à tous les zooms : autoroutes et
  // nationales dès le zoom 7, départementales et métropolitaines dès le zoom 10. Autres voies :
  // tronçons de la BD TOPO, dès le zoom 15.
  const ROADS_TILES = "https://data.geopf.fr/tms/1.0.0/BDTOPO/{z}/{x}/{y}.pbf";
  const NUMBERED_TILES = "https://data.geopf.fr/tms/1.0.0/PLAN.IGN/{z}/{x}/{y}.pbf";
  const ROADS_MINZOOM = 15;
  const CARTOUCHES = {
    A: { fond: "#e2001a", texte: "#ffffff" }, N: { fond: "#e2001a", texte: "#ffffff" },
    D: { fond: "#ffd400", texte: "#000000" }, M: { fond: "#00a3e0", texte: "#ffffff" },
    C: { fond: "#ffffff", texte: "#000000", listel: "#000000" }, R: { fond: "#ffffff", texte: "#000000", listel: "#000000" },
    E: { fond: "#2e9f45", texte: "#ffffff" }, F: { fond: "#2e9f45", texte: "#ffffff" },
  };
  const ROADS_LAYERS = ["voies-lisere", "voies", "numerotees-lisere", "numerotees", "numerotees-cartouches", "voies-cartouches"];
  // Couleur du trait : celle du cartouche (premier numéro) ; gris sans numéro
  const roadColor = (field) => ["match", ["slice", ["coalesce", ["get", field], ""], 0, 1],
    ["A", "N"], "#e2001a", "D", "#ffd400", "M", "#00a3e0", ["C", "R"], "#ffffff", "#bdbdbd"];
  const roadWidth = (extra) => ["interpolate", ["linear"], ["zoom"], 8, 1.5 + extra, 12, 2.5 + extra, 19, 4.5 + extra];

  // Filaire Panoramax semi-transparent : le fond (routes, orthophoto) reste visible dessous
  const NETWORK_OPACITY = 0.45;
  const NETWORK_LAYERS = ["grille", "sequences", "photos"];
  // Noms sur l'orthophoto : style « toponymes » du Plan IGN vectoriel (noms blancs détourés de
  // noir, conçus pour l'orthophoto), dont on ne garde que les communes et lieux-dits et les
  // noms de rues (les numéros de route sont dans les cartouches des voies) ; chargé au premier
  // choix de ce fond
  const NAMES_STYLE = "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/toponymes.json";
  const NAMES_LAYERS = ["toponyme_localite_ponc", "toponyme_routier_odonyme_lin"];
  const NAMES_SCALE = 1.3;  // texte agrandi : lisible sur l'orthophoto dans la petite carte
  /** Taille de texte du style IGN (nombre ou paliers { stops }) multipliée par NAMES_SCALE. */
  const scaledSize = (size) => (typeof size === "number" ? size * NAMES_SCALE
    : size?.stops ? { ...size, stops: size.stops.map(([z, v]) => [z, v * NAMES_SCALE]) } : size);
  // PCRS (plan de corps de rue simplifié, image à 5 cm) : publié par zones, selon les
  // producteurs ; la couche de la zone est donnée par le graphe de mosaïquage de l'ANCT
  const pcrsTiles = (layer) => `${GEOPF}/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}`
    + "&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/jpeg";
  let pcrsLayer = "PCRS.LAMB93";
  // Ortho-express : une couche par année de vol, produite vite après la prise de vue, qui ne
  // couvre que les zones photographiées cette année-là (orthophoto standard dessous)
  const EXPRESS_LAYERS = {
    2023: "ORTHOIMAGERY.ORTHOPHOTOS.ORTHO-EXPRESS.2023",
    2024: "ORTHOIMAGERY.ORTHOPHOTOS.ORTHO-EXPRESS.2024",
    2025: "ORTHOIMAGERY.ORTHOPHOTOS.ORTHO-EXPRESS.2025",
    2026: "ORTHOIMAGERY.ORTHOPHOTOS.RVB-EXPRESS.2026",
  };
  const EXPRESS_YEARS = Object.keys(EXPRESS_LAYERS).map(Number);
  let expressYear = Math.max(...EXPRESS_YEARS);
  const ATTRIBUTION_PANORAMAX = '<a href="https://panoramax.fr">Panoramax</a>';
  const EMPTY = { type: "FeatureCollection", features: [] };
  const kind = (...kinds) => ["in", ["get", "kind"], ["literal", kinds]];

  function createMap(container) {
    const map = new maplibregl.Map({
      container,
      attributionControl: false,  // ajouté replié ci-dessous
      center: [5.04, 47.32],  // Côte-d'Or
      zoom: 9,
      maxPitch: 0,  // carte toujours vue d'aplomb : le clic droit glissé ne l'incline plus
      pitchWithRotate: false,
      style: {
        version: 8,
        sources: {
          plan: {
            type: "raster", tiles: [wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png")],
            tileSize: 256, maxzoom: 19, attribution: ATTRIBUTION_IGN,
          },
          ortho: {
            type: "raster", tiles: [wmts("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg")],
            tileSize: 256, maxzoom: 20, attribution: ATTRIBUTION_IGN,
          },
          express: {
            type: "raster", tiles: [wmts(EXPRESS_LAYERS[expressYear], "image/jpeg")],
            tileSize: 256, maxzoom: 20, attribution: ATTRIBUTION_IGN,
          },
          pcrs: { type: "raster", tiles: [pcrsTiles(pcrsLayer)], tileSize: 256, maxzoom: 22, attribution: ATTRIBUTION_IGN },
          osm: { type: "raster", tiles: osmTiles, tileSize: 256, maxzoom: 19, attribution: ATTRIBUTION_OSM },
          panoramax: {
            type: "vector", tiles: [tilesUrl()], minzoom: 0, maxzoom: 15, attribution: ATTRIBUTION_PANORAMAX,
          },
          mesures: { type: "geojson", data: EMPTY },
          pr: { type: "geojson", data: EMPTY },
          contour: { type: "geojson", data: EMPTY },  // commune choisie dans la recherche (recherche.js)
          voies: { type: "vector", tiles: [ROADS_TILES], minzoom: ROADS_MINZOOM, maxzoom: 19, attribution: ATTRIBUTION_IGN },
          // tuiles jusqu'au zoom 13 seulement, agrandies au-delà : à partir du zoom 14, le Plan IGN
          // dédouble les routes à chaussées séparées
          numerotees: { type: "vector", tiles: [NUMBERED_TILES], maxzoom: 13, attribution: ATTRIBUTION_IGN },
          ...Object.fromEntries(ADMIN_LEVELS.map((level) => ["admin-" + level.id, { type: "geojson", data: EMPTY }])),
        },
        layers: [
          { id: "plan", type: "raster", source: "plan" },
          { id: "ortho", type: "raster", source: "ortho", layout: { visibility: "none" } },
          { id: "express", type: "raster", source: "express", layout: { visibility: "none" } },
          { id: "pcrs", type: "raster", source: "pcrs", minzoom: 15, layout: { visibility: "none" } },
          { id: "osm", type: "raster", source: "osm", layout: { visibility: "none" } },
          // Filaire des voies, sous les limites administratives : voies sans numéro de la BD TOPO
          // (sentiers, escaliers et bacs exclus), puis routes numérotées du Plan IGN
          ...[["voies-lisere", true], ["voies", false]].map(([id, casing]) => ({
            id, type: "line", source: "voies", "source-layer": "troncon_de_route", minzoom: ROADS_MINZOOM,
            filter: ["all", ["!", ["has", "cpx_numero"]],
              ["!", ["in", ["get", "nature"], ["literal", ["Sentier", "Escalier", "Bac ou liaison maritime"]]]]],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: casing ? { "line-color": "#333333", "line-opacity": 0.5, "line-width": roadWidth(1.5) }
              : { "line-color": roadColor("cpx_numero"), "line-opacity": 0.8, "line-width": roadWidth(0) },
          })),
          ...[["numerotees-lisere", true], ["numerotees", false]].map(([id, casing]) => ({
            id, type: "line", source: "numerotees", "source-layer": "toponyme_routier_numero_lin",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: casing ? { "line-color": "#333333", "line-opacity": 0.5, "line-width": roadWidth(1.5) }
              : { "line-color": roadColor("texte"), "line-opacity": 0.8, "line-width": roadWidth(0) },
          })),
          // Limites administratives : contours des polygones, sous le filaire et les mesures
          // (liseré blanc dessous : lisibles sur l'orthophoto)
          ...ADMIN_LEVELS.flatMap((level) => [
            {
              id: `admin-${level.id}-lisere`, type: "line", source: "admin-" + level.id, minzoom: level.minzoom,
              ...(level.filter && { filter: level.filter }),
              layout: { "line-join": "round" },
              paint: { "line-color": "#ffffff", "line-opacity": 0.6, "line-width": adminWidth(level, 2) },
            },
            {
              id: "admin-" + level.id, type: "line", source: "admin-" + level.id, minzoom: level.minzoom,
              ...(level.filter && { filter: level.filter }),
              layout: { "line-join": "round" },
              paint: { "line-opacity": 0.85, ...level.paint, "line-width": adminWidth(level, 0) },
            },
          ]),
          // Filaire : densité à petite échelle, séquences, puis photos
          {
            id: "grille", type: "circle", source: "panoramax", "source-layer": "grid", maxzoom: 7,
            paint: { "circle-color": ORANGE, "circle-opacity": NETWORK_OPACITY, "circle-radius": 2 },
          },
          {
            id: "sequences", type: "line", source: "panoramax", "source-layer": "sequences", minzoom: 6,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ORANGE, "line-opacity": NETWORK_OPACITY,
              "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 1.5, 17, 3],
            },
          },
          {
            id: "photos", type: "circle", source: "panoramax", "source-layer": "pictures", minzoom: 15,
            paint: {
              "circle-color": ORANGE, "circle-radius": 2.5, "circle-opacity": NETWORK_OPACITY,  // plus petits que le filaire d'origine (3,5)
              "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.7, "circle-stroke-opacity": NETWORK_OPACITY,
            },
          },
          // Cartouches des routes numérotées sous le zoom 15 (Plan IGN), puis de la BD TOPO, qui
          // porte aussi les numéros européens
          {
            id: "numerotees-cartouches", type: "symbol", source: "numerotees", "source-layer": "toponyme_routier_numero_lin",
            maxzoom: ROADS_MINZOOM,
            layout: {
              "symbol-placement": "line", "symbol-spacing": 400, "icon-rotation-alignment": "viewport",
              "icon-padding": 60, "icon-image": ["concat", "cartouche:|", ["get", "texte"]],
            },
          },
          // Cartouches des numéros de route (images dessinées à la demande, voir cartoucheImage),
          // droits quel que soit le sens de la route, au-dessus du filaire Panoramax
          {
            id: "voies-cartouches", type: "symbol", source: "voies", "source-layer": "troncon_de_route", minzoom: ROADS_MINZOOM,
            // ni bretelles ni giratoires (un échangeur en serait couvert) ; marge autour de chaque
            // cartouche : deux cartouches proches (chaussées séparées, tronçons voisins) ne
            // s'affichent pas ensemble
            filter: ["all", ["any", ["has", "cpx_numero"], ["has", "cpx_numero_route_europeenne"]],
              ["!", ["in", ["get", "nature"], ["literal", ["Bretelle", "Rond-point"]]]]],
            layout: {
              "symbol-placement": "line", "symbol-spacing": 400, "icon-rotation-alignment": "viewport",
              "icon-padding": 60,
              "icon-image": ["concat", "cartouche:", ["coalesce", ["get", "cpx_numero_route_europeenne"], ""], "|",
                ["coalesce", ["get", "cpx_numero"], ""]],
            },
          },
          // Contour de la commune choisie dans la recherche de lieux : liseré blanc, tirets
          {
            id: "contour-halo", type: "line", source: "contour",
            paint: { "line-color": "#ffffff", "line-width": 4, "line-opacity": 0.8 },
          },
          {
            id: "contour", type: "line", source: "contour",
            paint: { "line-color": "#3949ab", "line-width": 2, "line-dasharray": [3, 2] },
          },
          // Points de repère des routes (voir showMilestones), sous le curseur et les mesures
          {
            id: "pr", type: "circle", source: "pr", minzoom: PR_MINZOOM,
            paint: {
              "circle-color": VERT_PR, "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 4.5],
              "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
            },
          },
          // Curseur de vue : position, direction et ouverture de la vue
          // Mesures, visées et points (voir web_app.App.map_geojson)
          {
            id: "visees-halo", type: "line", source: "mesures", filter: kind("visee", "calage"),
            paint: { "line-color": "#ffffff", "line-opacity": 0.8, "line-width": 4 },
          },
          {
            id: "visees", type: "line", source: "mesures", filter: kind("visee"),
            paint: { "line-color": ROUGE, "line-width": 2, "line-dasharray": [3, 2] },
          },
          {  // calage du cap : visées vers les repères en tirets noirs, à ne pas prendre pour une triangulation
            id: "calages", type: "line", source: "mesures", filter: kind("calage"),
            paint: { "line-color": "#000000", "line-width": 2, "line-dasharray": [3, 2] },
          },
          {  // plan perpendiculaire : bande bleue sous le trait rouge, visible quand ils se confondent
            id: "plans", type: "line", source: "mesures", filter: kind("trace"),
            layout: { "line-cap": "round" },
            paint: { "line-color": BLEU, "line-opacity": 0.8, "line-width": 7 },
          },
          {
            id: "traits", type: "line", source: "mesures", filter: kind("mesure", "distance"),
            paint: { "line-color": ROUGE, "line-width": 3 },
          },
          {  // point triangulé gardé (point de référence d'une hauteur) : disque plus large que la
            // croix de mesure, dessiné dessous, pour rester visible autour d'elle
            id: "triangules", type: "circle", source: "mesures", filter: kind("triangule"),
            paint: {
              "circle-color": ROUGE, "circle-opacity": 0.6, "circle-radius": 6.5,
              "circle-stroke-color": ROUGE, "circle-stroke-width": 1.5,
            },
          },
          {  // croix jaunes, comme dans la visionneuse (image fournie à la demande, voir crossImage)
            id: "points", type: "symbol", source: "mesures", filter: kind("point"),
            layout: { "icon-image": "croix", "icon-allow-overlap": true, "icon-ignore-placement": true },
          },
          {
            id: "cibles", type: "circle", source: "mesures", filter: kind("cible", "repere"),
            paint: {
              "circle-color": "rgba(0, 0, 0, 0)", "circle-radius": 7, "circle-stroke-width": 2.5,
              "circle-stroke-color": ["match", ["get", "kind"], "repere", "#000000", ROUGE],  // repère du calage : noir
            },
          },
        ],
      },
    });
    map.on("styleimagemissing", (e) => {
      if (e.id === "croix" && !map.hasImage("croix")) map.addImage("croix", crossImage(), { pixelRatio: 2 });
      if (e.id.startsWith("cartouche:") && !map.hasImage(e.id)) {
        map.addImage(e.id, cartoucheImage(e.id.slice("cartouche:".length)), { pixelRatio: 2 });
      }
    });
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    // Attributions repliées derrière le bouton ⓘ : MapLibre les déplie d'office quand elles
    // arrivent (classe maplibregl-compact-show) ; repliées une fois la carte prête
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.once("idle", () => {
      map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });
    return map;
  }

  /** Croix jaune d'un point cliqué, cernée de sombre (18 pixels, dessinée au double). */
  /** Cartouches d'une route, "européens|numéros" (numéros séparés par « / ») : les européens à
   * gauche des autres, comme sur les panneaux. Lettre, numéro (espacés s'il a au plus deux
   * chiffres, comme dans l'IISR : « D 28 », « N106 ») et suffixe en minuscule italique. */
  function cartoucheImage(spec) {
    const [european, numbers] = spec.split("|");
    const parts = [european, numbers].flatMap((list) => list.split("/").map((n) => n.replace(/\s+/g, "")).filter(Boolean))
      .map((n) => /^([A-Z])(\d+)([A-Z]*)$/.exec(n) || [n, n, "", ""]);
    const scale = 2, height = 17 * scale, gap = 3 * scale, pad = 4 * scale, squeeze = 0.86;  // caractères resserrés
    const bold = `700 ${12 * scale}px Roboto, sans-serif`, italic = `italic 700 ${12 * scale}px Roboto, sans-serif`;
    const ctx = document.createElement("canvas").getContext("2d");
    const pieces = parts.map(([, letter, digits, suffix]) => {
      const main = letter + (digits && digits.length <= 2 ? " " : "") + digits;
      ctx.font = bold;
      const mainWidth = ctx.measureText(main).width * squeeze;
      ctx.font = italic;
      const suffixWidth = suffix ? ctx.measureText(suffix.toLowerCase()).width * squeeze + scale : 0;
      return { letter, main, suffix: suffix.toLowerCase(), mainWidth, width: mainWidth + suffixWidth + 2 * pad };
    });
    const width = Math.max(1, pieces.reduce((sum, p) => sum + p.width, 0) + gap * (pieces.length - 1));
    const canvas = ctx.canvas;
    canvas.width = Math.ceil(width) + 2;
    canvas.height = height + 2;
    let x = 1;
    for (const p of pieces) {
      const style = CARTOUCHES[p.letter] || CARTOUCHES.C;
      ctx.beginPath();
      ctx.roundRect(x, 1, p.width, height, 3 * scale);
      ctx.fillStyle = style.fond;
      ctx.fill();
      ctx.lineWidth = style.listel ? 1.5 * scale : 1;
      ctx.strokeStyle = style.listel || "rgba(0, 0, 0, 0.35)";  // fonds sans listel : fin contour, lisible sur la carte
      ctx.stroke();
      ctx.fillStyle = style.texte;
      ctx.textBaseline = "middle";
      ctx.save();
      ctx.translate(x + pad, 1 + height / 2 + scale / 2);
      ctx.scale(squeeze, 1);
      ctx.font = bold;
      ctx.fillText(p.main, 0, 0);
      if (p.suffix) {
        ctx.font = italic;
        ctx.fillText(p.suffix, p.mainWidth / squeeze + scale, 0);
      }
      ctx.restore();
      x += p.width + gap;
    }
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /** Affiche ou masque le filaire des voies et ses cartouches. */
  function setRoadsVisible(map, shown) {
    for (const id of ROADS_LAYERS) map.setLayoutProperty(id, "visibility", shown ? "visible" : "none");
  }

  function crossImage() {
    const size = 36, canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const c = size / 2, arm = 16;
    for (const [color, width] of [["rgba(0, 0, 0, 0.7)", 8], [JAUNE, 4]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(c - arm, c); ctx.lineTo(c + arm, c);
      ctx.moveTo(c, c - arm); ctx.lineTo(c, c + arm);
      ctx.stroke();
    }
    return ctx.getImageData(0, 0, size, size);
  }

  function setBackground(map, name) {
    if (!BACKGROUNDS.includes(name)) name = "plan";  // fond mémorisé inconnu
    for (const id of BACKGROUNDS) {
      if (id === "noms") continue;  // pas une couche : l'orthophoto et les noms par-dessus
      // Ortho-express : orthophoto standard dessous, là où l'année choisie n'a pas été survolée
      const shown = id === name || (["noms", "express", "pcrs"].includes(name) && id === "ortho");
      map.setLayoutProperty(id, "visibility", shown ? "visible" : "none");
    }
    namesShown = name === "noms";
    if (namesShown) loadNames(map);
    // Orthophoto avec noms : avec les voies et les limites administratives
    setRoadsVisible(map, namesShown);
    setAdminVisible(map, namesShown);
    for (const id of namesIds) map.setLayoutProperty(id, "visibility", namesShown ? "visible" : "none");
  }

  /** Affiche ou masque le filaire Panoramax (séquences et photos). */
  function setNetworkVisible(map, shown) {
    for (const id of NETWORK_LAYERS) map.setLayoutProperty(id, "visibility", shown ? "visible" : "none");
  }

  let namesShown = false;
  let namesIds = [];  // couches des noms, une fois chargées
  let namesLoading = null;

  /** Ajoute (une fois) les couches de noms du Plan IGN vectoriel, sous le filaire et les mesures. */
  function loadNames(map) {
    namesLoading ??= (async () => {
      try {
        const style = await (await fetch(NAMES_STYLE)).json();
        const { tiles, scheme } = Object.values(style.sources)[0];
        map.setGlyphs(style.glyphs);
        map.setSprite(style.sprite);
        map.addSource("noms", { type: "vector", tiles, scheme, minzoom: 0, maxzoom: 18, attribution: ATTRIBUTION_IGN });
        for (const layer of style.layers) {
          if (layer.type !== "symbol" || !NAMES_LAYERS.includes(layer["source-layer"])) continue;
          if ((layer.maxzoom ?? 24) <= 5) continue;  // pays, continent
          const id = "noms-" + layer.id;
          // Les noms de communes et les numéros de route s'arrêtent au zoom 16 à 18 dans le
          // style IGN : on les garde jusqu'au plus grand zoom de la carte, où l'on mesure
          const big = (layer.maxzoom ?? 24) > 13;
          map.addLayer({
            ...layer, id, source: "noms", maxzoom: big ? 24 : layer.maxzoom,
            layout: {
              ...layer.layout, visibility: namesShown ? "visible" : "none",
              ...(layer.layout?.["text-size"] != null && { "text-size": scaledSize(layer.layout["text-size"]) }),
            },
          }, "grille");
          namesIds.push(id);
        }
      } catch (error) {
        console.warn("Noms du Plan IGN indisponibles :", error);
        namesLoading = null;  // nouvel essai au prochain choix du fond
      }
    })();
  }

  /** Ortho-express au plus près de l'année `year` (celle de la photo) parmi les années qui
   * couvrent l'endroit (lon, lat) : une tuile demandée par année candidate, de la plus proche
   * à la plus lointaine, réponses gardées par maille. Retourne l'année retenue (null si aucune
   * ne couvre l'endroit : la couche est alors celle de l'année la plus proche, vide ici). */
  const expressCover = new Map();  // "année maille" -> couverte ?
  let expressRequest = 0;  // n° de la dernière demande : une réponse plus ancienne ne change plus la couche

  async function setExpressYear(map, year, lon, lat) {
    const request = ++expressRequest;
    const order = [...EXPRESS_YEARS].sort((a, b) => Math.abs(a - year) - Math.abs(b - year) || b - a);
    let chosen = null;
    for (const y of order) {
      if (await expressCovers(y, lon, lat)) {
        chosen = y;
        break;
      }
    }
    const shown = chosen ?? order[0];
    if (request === expressRequest && shown !== expressYear) {
      expressYear = shown;
      whenLoaded(map, () => map.getSource("express").setTiles([wmts(EXPRESS_LAYERS[shown], "image/jpeg")]));
    }
    return chosen;
  }

  async function expressCovers(year, lon, lat) {
    const z = 14, n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n);
    const r = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    const key = `${year} ${x} ${y}`;
    if (!expressCover.has(key)) {
      const url = wmts(EXPRESS_LAYERS[year], "image/jpeg").replace("{z}", z).replace("{y}", y).replace("{x}", x);
      try {
        const response = await fetch(url);
        expressCover.set(key, response.ok && (response.headers.get("content-type") || "").startsWith("image/"));
      } catch {
        return false;  // service injoignable : pas gardé, redemandé plus tard
      }
    }
    return expressCover.get(key);
  }

  /** PCRS publié sur la Géoplateforme à l'endroit (lon, lat) : { layer, producteur, date } ou
   * null (graphe de mosaïquage du PCRS, ANCT ; réponses gardées au centième de degré). La
   * couche du fond PCRS devient celle de cette zone. */
  const pcrsCache = new Map();
  let pcrsRequest = 0;  // n° de la dernière demande : une réponse plus ancienne ne change plus la couche

  async function pcrsAt(map, lon, lat) {
    const request = ++pcrsRequest;
    const key = `${lon.toFixed(2)},${lat.toFixed(2)}`;
    if (!pcrsCache.has(key)) {
      const d = 0.0005;
      const params = new URLSearchParams({
        SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: "GRAPHE.PCRS.ANCT:graphe_pcrs_anct",
        OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: "5",
        BBOX: `${lat - d},${lon - d},${lat + d},${lon + d},urn:ogc:def:crs:EPSG::4326`,
      });
      try {
        const response = await fetch(`${GEOPF}/wfs/ows?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Seules les zones diffusées par le service d'images de la Géoplateforme sont utilisables ici
        const zone = ((await response.json()).features || []).map((f) => f.properties || {})
          .find((p) => p.diffusion_layer && (p.diffusion_url || "").includes("data.geopf.fr/wms-r"));
        pcrsCache.set(key, zone ? { layer: zone.diffusion_layer, producteur: zone.nom_acteur || "",
          date: (zone.date_livraison || "").slice(0, 10) } : null);
      } catch (error) {
        console.warn("PCRS :", error);
        return null;  // service injoignable : pas gardé, redemandé plus tard
      }
    }
    const zone = pcrsCache.get(key);
    if (request === pcrsRequest && zone && zone.layer !== pcrsLayer) {
      pcrsLayer = zone.layer;
      whenLoaded(map, () => map.getSource("pcrs").setTiles([pcrsTiles(pcrsLayer)]));
    }
    return zone;
  }

  // Instance Panoramax -------------------------------------------------------------------

  /** Instances connues du méta-catalogue : [[nom, adresse du site]], triées. */
  async function instances() {
    const response = await fetch(`${META_API}/instances`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.instances || []).filter((i) => i.url).map((i) => [i.name || i.url, i.url])
      .sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
  }

  /** Carte prête (style chargé) : fn tout de suite, sinon à son chargement. */
  function whenLoaded(map, fn) {
    if (map.isStyleLoaded()) fn();
    else map.once("load", fn);
  }

  /** Bascule sur une instance (adresse de son site), ou sur le méta-catalogue (""). */
  function setInstance(map, base) {
    let site = (base || "").replace(/\/+$/, "");
    if (site.endsWith("/api")) site = site.slice(0, -4);
    apiUrl = site ? `${site}/api` : META_API;
    const url = tilesUrl();
    whenLoaded(map, () => map.getSource("panoramax").setTiles([url]));
    return apiUrl;
  }

  // Filtre des photos (même critères que le plugin, voir core/filters.py) ------------------

  function setFilter(map, f) {
    if (!map.isStyleLoaded()) {  // MapLibre refuse un filtre avant le chargement du style
      map.once("load", () => setFilter(map, f));
      return;
    }
    const tileTypes = { 360: "equirectangular", flat: "flat" };
    for (const [layer, dateField] of [["sequences", "date"], ["photos", "ts"]]) {
      const parts = ["all"];
      if (f.since) parts.push([">=", ["to-string", ["get", dateField]], f.since]);
      if (f.kind) parts.push(["==", ["get", "type"], tileTypes[f.kind]]);
      if (f.max_gps != null) {
        parts.push(["has", "gps_accuracy"], ["<=", ["to-number", ["get", "gps_accuracy"], 1e9], f.max_gps]);
      }
      if (f.producer) parts.push(["==", ["get", "account_id"], f.producer[0]]);
      map.setFilter(layer, parts.length > 1 ? parts : null);
    }
    const grid = f.kind ? [">", ["to-number", ["get", f.kind === "360" ? "nb_360_pictures" : "nb_flat_pictures"], 0], 0]
      : null;
    map.setFilter("grille", grid);
  }

  // Points de repère (PR) des routes : BD TOPO, zone affichée, à partir de PR_MINZOOM ; leur
  // étiquette (marqueur HTML, sans police à charger) à partir de PR_LABEL_ZOOM ---------------

  const PR_MINZOOM = 13;
  const PR_LABEL_ZOOM = PR_MINZOOM;  // bornes dès que les points paraissent
  const prLabels = [];
  let prTimer = null, prAsked = 0, prKey = "";

  /** Limites administratives chargées à la volée : pour chaque niveau affiché au zoom courant,
   * la zone vue (élargie) est demandée au WFS si aucune zone déjà chargée ne la contient ;
   * entités gardées par jeu de données (petite échelle ou précis) et par identifiant. */
  const adminCache = new Map();  // "jeu:couche" -> { boxes: [[o, s, e, n]], features: Map }
  let adminShown = false, adminTimer = null;

  function showAdmin(map) {
    map.on("moveend", () => {
      clearTimeout(adminTimer);
      adminTimer = setTimeout(() => loadAdmin(map), 300);
    });
  }

  function setAdminVisible(map, shown) {
    adminShown = shown;
    for (const level of ADMIN_LEVELS) {
      for (const id of ["admin-" + level.id, `admin-${level.id}-lisere`]) map.setLayoutProperty(id, "visibility", shown ? "visible" : "none");
    }
    if (shown) loadAdmin(map);
  }

  function loadAdmin(map) {
    if (!adminShown) return;
    const zoom = map.getZoom();
    const b = map.getBounds();
    const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    for (const level of ADMIN_LEVELS) {
      if (zoom < level.minzoom) continue;
      const dataset = adminDataset(level, zoom);
      adminFetch(`${dataset}:${level.layer}`, view, level.properties || "cleabs,nom_officiel,geometrie", (features) => {
        // jeu de données encore celui du zoom courant
        if (adminDataset(level, map.getZoom()) === dataset) {
          map.getSource("admin-" + level.id)?.setData({ type: "FeatureCollection", features });
        }
      });
    }
  }

  /** Entités de la couche WFS `key` autour de la zone vue `view` : passées à `show` tout de
   * suite (celles déjà connues) puis à l'arrivée de la réponse, si la zone n'était pas chargée. */
  function adminFetch(key, view, properties, show) {
    if (!adminCache.has(key)) adminCache.set(key, { boxes: [], features: new Map() });
    const entry = adminCache.get(key);
    const all = () => show([...entry.features.values()]);
    const inside = (box) => box[0] <= view[0] && box[1] <= view[1] && box[2] >= view[2] && box[3] >= view[3];
    if (!entry.boxes.some(inside)) {
      // Zone vue élargie de moitié de chaque côté : petits déplacements sans nouvelle requête
      const w = view[2] - view[0], h = view[3] - view[1];
      const box = [view[0] - w / 2, view[1] - h / 2, view[2] + w / 2, view[3] + h / 2];
      entry.boxes.push(box);
      const params = new URLSearchParams({
        SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: key,
        OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: "1000", PROPERTYNAME: properties,
        BBOX: `${box[1]},${box[0]},${box[3]},${box[2]},urn:ogc:def:crs:EPSG::4326`,
      });
      fetch(`${GEOPF}/wfs/ows?${params}`)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((data) => {
          for (const f of data.features || []) entry.features.set(f.properties?.cleabs ?? f.id, f);
          all();
        })
        .catch((error) => {
          console.warn(`Limites administratives (${key}) :`, error);
          entry.boxes.splice(entry.boxes.indexOf(box), 1);  // à redemander
        });
    }
    all();  // entités déjà connues tout de suite (changement de zoom)
  }

  function showMilestones(map) {
    map.on("moveend", () => {
      clearTimeout(prTimer);
      prTimer = setTimeout(() => loadMilestones(map), 300);
    });
    whenLoaded(map, () => loadMilestones(map));
  }

  async function loadMilestones(map) {
    const zoom = map.getZoom();
    const b = map.getBounds();
    // Zone chargée arrondie (et un peu élargie) : petits déplacements sans nouvelle requête
    const r = (v, up) => (up ? Math.ceil(v * 200) : Math.floor(v * 200)) / 200;
    const box = [r(b.getWest(), false), r(b.getSouth(), false), r(b.getEast(), true), r(b.getNorth(), true)];
    const key = zoom >= PR_MINZOOM ? box.join(",") + (zoom >= PR_LABEL_ZOOM ? "+" : "") : "";
    if (key === prKey) return;
    prKey = key;
    const ticket = ++prAsked;
    let features = [], sections = new Map();
    if (zoom >= PR_MINZOOM) {
      const wfs = (layer, extra = {}) => new URLSearchParams({
        SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: `BDTOPO_V3:${layer}`,
        OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: "1000",
        BBOX: `${box[1]},${box[0]},${box[3]},${box[2]},urn:ogc:def:crs:EPSG::4326`, ...extra,
      });
      // Sections de PR (tracé de la route, sens des PR croissants) : bornes posées à côté de la voie
      const sectionsAsked = zoom < PR_LABEL_ZOOM ? Promise.resolve([])
        : fetch(`${GEOPF}/wfs/ows?${wfs("section_de_points_de_repere", { PROPERTYNAME: "identifiant_de_section,geometrie" })}`)
          .then((response) => (response.ok ? response.json() : { features: [] }))
          .then((data) => data.features || [])
          .catch(() => []);  // sans elles, bornes au-dessus du point
      try {
        const response = await fetch(`${GEOPF}/wfs/ows?${wfs("point_de_repere")}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        features = ((await response.json()).features || [])
          .filter((f) => /^\d+$/.test(String(f.properties?.numero)));  // ni début ni fin de section
        for (const section of await sectionsAsked) sections.set(section.properties.identifiant_de_section, section.geometry);
      } catch (error) {
        console.warn("Points de repère :", error);
        prKey = null;  // à redemander (et pas "" : celle d'un zoom trop faible, qui n'effacerait rien)
        return;
      }
    }
    if (ticket !== prAsked) return;  // zone déjà quittée
    const seen = new Set();  // un seul PR par route et numéro (côtés droit et gauche)
    features = features.filter((f) => {
      const id = `${f.properties.route} ${f.properties.numero}`;
      return !seen.has(id) && seen.add(id);
    });
    map.getSource("pr")?.setData({ type: "FeatureCollection", features });
    for (const marker of prLabels.splice(0)) marker.remove();
    if (zoom < PR_LABEL_ZOOM) return;
    for (const f of features) {
      // Borne de PR (comme la borne E53 de l'IISR) : tête en demi-cercle à la couleur du réseau,
      // corps blanc portant le numéro du PR
      const element = document.createElement("div");
      element.className = "borne-pr";
      element.dataset.reseau = String(f.properties.route).charAt(0);
      const head = document.createElement("span");
      head.className = "tete";  // sans texte : la couleur dit le réseau
      const body = document.createElement("span");
      body.className = "corps";
      body.textContent = f.properties.numero;
      element.append(head, body);
      // Sens de la route au PR (vers les PR croissants) et côté de la borne : celui du PR,
      // à droite pour une route à une seule chaussée (côté « U ») ; centrée à côté de la voie
      // (placeBornes), ou au-dessus du point sans sens connu
      const direction = sectionDirection(sections.get(f.properties.identifiant_de_section), f.geometry.coordinates);
      const marker = new maplibregl.Marker(direction ? { element, anchor: "center" } : { element, anchor: "bottom", offset: [0, -4] })
        .setLngLat(f.geometry.coordinates).addTo(map);
      if (direction) marker.borne = { direction, left: f.properties.cote === "G" };
      prLabels.push(marker);
    }
    placeBornes(map);
    if (!bornesFollow) {
      bornesFollow = true;
      map.on("zoom", () => placeBornes(map));
      map.on("rotate", () => placeBornes(map));
    }
  }

  let bornesFollow = false;
  const BORNE_ROAD_HALF_WIDTH = 6;  // m : demi-largeur de voie supposée, la borne est posée au-delà
  const BORNE_GAP = 18;  // px : du bord de la voie au centre de la borne

  /** Direction (en degrés de longitude et de latitude) du tronçon de `geometry` le plus proche
   * de `point`, dans le sens de saisie (PR croissants) ; null sans géométrie. */
  function sectionDirection(geometry, [lon, lat]) {
    if (!geometry) return null;
    const lines = geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates];
    const k = Math.cos((lat * Math.PI) / 180);
    let best = null, bestDist = Infinity;
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1], [bx, by] = line[i];
        const dx = (bx - ax) * k, dy = by - ay, len2 = dx * dx + dy * dy;
        if (!len2) continue;
        const t = Math.max(0, Math.min(1, (((lon - ax) * k) * dx + (lat - ay) * dy) / len2));
        const ex = (ax + t * (bx - ax) - lon) * k, ey = ay + t * (by - ay) - lat;
        const dist = ex * ex + ey * ey;
        if (dist < bestDist) {
          bestDist = dist;
          best = [bx - ax, by - ay];
        }
      }
    }
    return best;
  }

  /** Décale chaque borne perpendiculairement à la route, hors de la voie, selon le zoom et
   * l'orientation de la carte. */
  function placeBornes(map) {
    const metersPerPixel = (lat) => (40075016.7 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    for (const marker of prLabels) {
      if (!marker.borne) continue;
      const at = marker.getLngLat();
      const p = map.project(at);
      const q = map.project([at.lng + marker.borne.direction[0], at.lat + marker.borne.direction[1]]);
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;  // sens de la route à l'écran (y vers le bas)
      const [nx, ny] = marker.borne.left ? [uy, -ux] : [-uy, ux];  // côté gauche ou droit
      const distance = BORNE_ROAD_HALF_WIDTH / metersPerPixel(at.lat) + BORNE_GAP;
      marker.setOffset([nx * distance, ny * distance]);
    }
  }

  // Mesures --------------------------------------------------------------------------------

  // Étiquettes : marqueurs HTML (pas de police de caractères à charger)
  const labels = [];
  let shownMeasures = null;  // dernières mesures dessinées : suivent une poignée glissée

  function showMeasures(map, geojson) {
    shownMeasures = geojson;
    map.getSource("mesures")?.setData(geojson);
    for (const marker of labels.splice(0)) marker.remove();
    sublabels.length = 0;
    stacked.length = 0;
    for (const feature of geojson.features) {
      const { label, sublabel, kind: featureKind } = feature.properties;
      const coords = feature.geometry.type === "Point" ? feature.geometry.coordinates
        : middle(feature.geometry.coordinates);
      if (label) {
        const element = document.createElement("div");
        // Triangulation : fond d'une autre couleur, pour les points gardés et pour les distances
        element.className = "etiquette" + ({ triangule: " tri-point", distance: " tri" }[featureKind] || "");
        element.textContent = label;
        const marker = new maplibregl.Marker({ element, offset: labelOffset(element) }).setLngLat(coords).addTo(map);
        labels.push(marker);
        stacked.push(marker);
      }
      if (sublabel) {  // sous le trait, couchée le long de celui-ci (voir placeSublabels)
        const element = document.createElement("div");
        element.className = "ancre";
        element.innerHTML = '<div class="etiquette sous"></div>';
        element.firstChild.textContent = sublabel;
        const marker = new maplibregl.Marker({ element }).setLngLat(coords).addTo(map);
        const line = feature.geometry.coordinates;
        labels.push(marker);
        sublabels.push({ marker, text: element.firstChild, a: line[0], b: line[line.length - 1] });
      }
    }
    if (!sublabelsBound) {
      sublabelsBound = true;
      map.on("move", () => placeSublabels(map));
      map.on("moveend", () => declutter());
    }
    placeSublabels(map);
    declutter();
  }

  // Étiquettes des mesures sans chevauchement : une étiquette qui en recouvre une autre déjà
  // placée est écartée encore, autant de fois que nécessaire (recalculé après chaque
  // déplacement ou zoom de la carte). Mesures au-dessus de leur point, points triangulés
  // dessous : le pied d'une hauteur est souvent sur son point de référence.
  const LABEL_OFFSET = 26;  // écart au point : dégage la croix de mesure (18 px)
  const stacked = [];

  /** Sens de l'étiquette : -1 au-dessus (mesures), 1 dessous (points triangulés). */
  const labelSide = (element) => (element.classList.contains("tri-point") ? 1 : -1);
  const labelOffset = (element) => [0, labelSide(element) * LABEL_OFFSET];

  function declutter() {
    const placed = [];
    for (const marker of stacked) {
      const element = marker.getElement();
      marker.setOffset(labelOffset(element));
      let rect = element.getBoundingClientRect();
      for (let k = 1; k <= 10 && placed.some((p) => overlaps(p, rect)); k++) {
        marker.setOffset([0, labelSide(element) * (LABEL_OFFSET + k * (rect.height + 2))]);
        rect = element.getBoundingClientRect();
      }
      placed.push(rect);
    }
  }

  function overlaps(a, b) {
    return a.left < b.right + 2 && b.left < a.right + 2 && a.top < b.bottom + 2 && b.top < a.bottom + 2;
  }

  // Étiquettes sous un trait : suivent son angle à l'écran, lisibles de gauche à droite, et
  // n'apparaissent que si le trait fait au moins deux fois leur largeur (sinon elles cachent tout)
  const sublabels = [];
  let sublabelsBound = false;

  function placeSublabels(map) {
    for (const { marker, text, a, b } of sublabels) {
      const pa = map.project(a), pb = map.project(b);
      let angle = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      marker.setRotation(angle);
      const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      text.style.visibility = length >= 2 * text.offsetWidth ? "visible" : "hidden";
    }
  }

  // Poignées : points des mesures à glisser pour les recaler.
  // Recréées seulement quand elles changent, et jamais pendant un glisser (le marqueur saisi
  // disparaîtrait avec le recalage en cours).
  const handles = [];
  let handlesKey = "";
  let dragging = false;
  let onMoved = null;

  function showHandles(map, list, moved) {
    onMoved = moved;
    const key = JSON.stringify(list);
    if (dragging || key === handlesKey) return;
    handlesKey = key;
    for (const marker of handles.splice(0)) marker.remove();
    list.forEach(([lon, lat], index) => {
      const element = document.createElement("div");
      element.className = "poignee";
      element.title = "Glisser pour recaler ce point sur la carte";
      const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat([lon, lat]).addTo(map);
      let from = [lon, lat];
      marker.on("dragstart", () => { dragging = true; });
      marker.on("drag", () => {  // la croix du point, ses traits et son étiquette suivent
        const { lng, lat: newLat } = marker.getLngLat();
        follow(map, from, [lng, newLat]);
        from = [lng, newLat];
      });
      marker.on("dragend", () => {
        dragging = false;
        handlesKey = "";  // redessinées d'après le recalage
        const { lng, lat: newLat } = marker.getLngLat();
        onMoved(index, lng, newLat);
      });
      handles.push(marker);
    });
  }

  /** Pendant un glisser : tout ce qui est dessiné en `from` (croix, bouts de traits,
   * étiquette d'une hauteur) passe en `to`, avant le recalcul au lâcher. */
  function follow(map, from, to) {
    if (!shownMeasures) return;
    const same = (c) => Math.abs(c[0] - from[0]) < 1e-9 && Math.abs(c[1] - from[1]) < 1e-9;
    const move = (c) => same(c) ? to : c;
    for (const feature of shownMeasures.features) {
      const g = feature.geometry;
      g.coordinates = g.type === "Point" ? move(g.coordinates) : g.coordinates.map(move);
    }
    map.getSource("mesures")?.setData(shownMeasures);
    for (const marker of labels) {
      const { lng, lat } = marker.getLngLat();
      if (same([lng, lat])) marker.setLngLat(to);
    }
  }

  function middle(coords) {
    const a = coords[0], b = coords[coords.length - 1];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  // Curseur de vue -------------------------------------------------------------------------

  let viewMarker = null, viewShape = "";

  /** Photo affichée et vue : cap (degrés), champ horizontal (degrés), ou heading null. Cône
   * de 70 pixels et axe jusqu'au bord de la carte, quelle que soit l'échelle : image SVG posée
   * sur la carte (marqueur HTML), tournée au cap de la vue. Tourner la vue ne redessine pas la
   * carte, seule l'image tourne (une couche GeoJSON la faisait redessiner à chaque image). */
  function showView(map, lonlat, heading, fov) {
    if (!lonlat) {
      viewMarker?.remove();
      viewMarker = null;
      return;
    }
    if (!viewMarker) {
      const element = document.createElement("div");
      element.className = "curseur-vue";
      viewMarker = new maplibregl.Marker({ element, rotationAlignment: "map", pitchAlignment: "map" });
      viewShape = "";
      if (!map.__vueSize) {  // axe jusqu'au bord : redessiné quand la carte change de taille
        map.__vueSize = true;
        map.on("resize", () => { viewShape = ""; if (lastView) showView(map, ...lastView); });
      }
    }
    lastView = [lonlat, heading, fov];
    const canvas = map.getCanvas();
    const reach = Math.ceil(Math.hypot(canvas.clientWidth, canvas.clientHeight) || 1000);  // carte pas encore mise en page
    const half = Math.min(fov || 90, 170) / 2;
    const shape = `${heading != null}|${Math.round(half * 10)}|${reach}`;
    if (shape !== viewShape) {  // champ ou taille changés : image refaite
      viewShape = shape;
      const r = 70, rad = (d) => (d * Math.PI) / 180;
      const point = (angle, length) => `${(length * Math.sin(rad(angle))).toFixed(1)} ${(-length * Math.cos(rad(angle))).toFixed(1)}`;
      const cone = heading == null ? "" : `<path d="M0 0L${point(-half, r)}A${r} ${r} 0 0 1 ${point(half, r)}Z"
          fill="${CURSEUR}" fill-opacity="0.25" stroke="${CURSEUR}" stroke-width="1.5"/>
        <line x1="0" y1="0" x2="0" y2="${-reach}" stroke="${CURSEUR}" stroke-width="2" stroke-opacity="0.6"/>`;
      viewMarker.getElement().innerHTML = `<svg width="${2 * reach}" height="${2 * reach}"
        viewBox="${-reach} ${-reach} ${2 * reach} ${2 * reach}">${cone}
        <circle r="6" fill="${CURSEUR}" stroke="#ffffff" stroke-width="2"/></svg>`;
    }
    viewMarker.setLngLat(lonlat).setRotation(heading ?? 0);
    if (!viewMarker._map) viewMarker.addTo(map);
  }
  let lastView = null;

  function offset([lon, lat], heading, distance) {
    const h = heading * Math.PI / 180;
    const dlat = distance * Math.cos(h) / 111320;
    const dlon = distance * Math.sin(h) / (111320 * Math.cos(lat * Math.PI / 180));
    return [lon + dlon, lat + dlat];
  }

  // Photo la plus proche d'un clic --------------------------------------------------------

  function metresBetween(a, b) {
    const rad = Math.PI / 180;
    const x = (b[0] - a[0]) * rad * Math.cos((a[1] + b[1]) / 2 * rad);
    const y = (b[1] - a[1]) * rad;
    return Math.hypot(x, y) * 6371008.8;
  }

  function metresPerPixel(map, lat) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** map.getZoom());
  }

  /**
   * Photo (fiche STAC) la plus proche du point, dans un rayon adapté à l'échelle (10 à 150 m),
   * parmi celles qui passent le filtre `accept` (fiche -> booléen).
   */
  async function nearestPhoto(map, lng, lat, accept = () => true) {
    const radius = Math.min(150, Math.max(10, 15 * metresPerPixel(map, lat)));
    const dlat = radius / 111320;
    const dlon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    const bbox = [lng - dlon, lat - dlat, lng + dlon, lat + dlat].map((v) => v.toFixed(7)).join(",");
    const search = async (limit) => {
      const response = await fetch(`${apiUrl}/search?bbox=${bbox}&limit=${limit}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const features = (await response.json()).features || [];
      let best = null;
      for (const feature of features) {
        if (!accept(feature)) continue;
        const d = metresBetween([lng, lat], feature.geometry.coordinates);
        if (!best || d < best.d) best = { feature, d };
      }
      return { best, full: features.length >= limit };
    };
    // 50 photos suffisent d'ordinaire ; si le filtre les écarte toutes et qu'il y en a d'autres
    // (réponse pleine, zone dense), une seconde recherche plus large (lourde : faite seulement là)
    let { best, full } = await search(SEARCH_LIMIT);
    if (!best && full) ({ best } = await search(SEARCH_LIMIT_FILTERED));
    return best ? best.feature : null;
  }
  const SEARCH_LIMIT = 50, SEARCH_LIMIT_FILTERED = 1000;

  /** Fiche STAC d'une photo, par son identifiant. */
  async function photoById(id) {
    const response = await fetch(`${apiUrl}/search?ids=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.features || [])[0] || null;
  }

  return {
    PANORAMAX_API: META_API, GEOPF, OSM_TILES, createMap, setBackground, setNetworkVisible, showAdmin, setExpressYear, pcrsAt, instances, setInstance, setFilter,
    showMeasures, showHandles, showView, showMilestones, nearestPhoto, photoById, apiUrl: () => apiUrl,
  };
})();
