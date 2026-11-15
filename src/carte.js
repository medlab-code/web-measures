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
  const VISEE = "#1b9e3e";  // parcelle cadastrale visée par la ligne de cap
  const SOUS_CAMERA = "#f2c200";  // parcelle cadastrale où se tient la caméra
  const VERT_PR = "#2e7d32";  // points de repère (PR) des routes

  let apiUrl = META_API;  // instance courante (voir setInstance)
  const tilesUrl = () => `${apiUrl}/map/{z}/{x}/{y}.mvt`;

  function wmts(layer, format) {
    return `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal` +
      `&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  }

  const ATTRIBUTION_IGN = '<a href="https://www.ign.fr">IGN</a>';
  const ATTRIBUTION_OFM = '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org">OpenMapTiles</a>, '
    + 'données © <a href="https://www.openstreetmap.org/copyright">les contributeurs d\'OpenStreetMap</a>';
  const BACKGROUNDS = ["plan", "ortho", "noms", "express", "pcrs", "mnh", "ofm"];
  // Fonds vectoriels (styles MapLibre publiés) : texte dessiné par le navigateur, net à toute résolution et agrandi
  // à volonté (textScale de createMap). Textes dans les polices de l'IGN, seul serveur de polices de la carte
  // (OpenFreeMap : Noto Sans remplacée par Source Sans Pro) ; pictogrammes de chaque style préfixés de sa clé.
  const GLYPHS = "https://data.geopf.fr/annexes/ressources/vectorTiles/fonts/{fontstack}/{range}.pbf";
  const VECTOR_BASES = {
    // Plan IGN vectoriel (page mobile, à la place des images du Plan IGN)
    planv: { style: "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json", maxzoom: 18, attribution: ATTRIBUTION_IGN },
    // OpenStreetMap par OpenFreeMap (gratuit, sans clé, en-têtes CORS)
    ofm: { style: "https://tiles.openfreemap.org/styles/liberty", attribution: ATTRIBUTION_OFM,
      font: (f) => f.replace("Noto Sans", "Source Sans Pro") },
  };
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
  /** Taille de texte d'un style multipliée par k : nombre, fonction à paliers (stops) ou expression (sorties d'un
   * interpolate ou d'un step sur le zoom, qui doit rester au sommet de l'expression). */
  const scaledSize = (size, k = NAMES_SCALE) => {
    const times = (v) => (typeof v === "number" ? v * k : ["*", v, k]);
    if (typeof size === "number") return size * k;
    if (size?.stops) return { ...size, stops: size.stops.map(([z, v]) => [z, v * k]) };
    if (!Array.isArray(size)) return size;
    if (size[0] === "interpolate") return [...size.slice(0, 3), ...size.slice(3).map((v, i) => (i % 2 ? times(v) : v))];
    if (size[0] === "step") return [...size.slice(0, 2), times(size[2]), ...size.slice(3).map((v, i) => (i % 2 ? times(v) : v))];
    return times(size);
  };
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

  /** Options de la page mobile : vectorPlan, Plan IGN vectoriel au lieu de ses images ; textScale, texte des fonds
   * vectoriels agrandi (lisible au doigt). */
  let mapOptions = { vectorPlan: false, textScale: 1 };
  function createMap(container, { vectorPlan = false, textScale = 1 } = {}) {
    mapOptions = { vectorPlan, textScale };
    const map = new maplibregl.Map({
      container,
      attributionControl: false,  // ajouté replié ci-dessous
      center: [5.04, 47.32],  // Côte-d'Or
      zoom: 9,
      maxZoom: 24,  // 0,6 cm par pixel : la Bird Eye (1,5 cm par pixel) se vise de près ; les fonds de carte sont agrandis
      maxPitch: 0,  // carte toujours vue d'aplomb : le clic droit glissé ne l'incline plus
      pitchWithRotate: false,
      style: {
        version: 8,
        glyphs: GLYPHS,
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
          // Modèle Numérique de Hauteur, issu du LiDAR HD (IGN) : estompage de la hauteur du sursol (bâtiments, arbres, talus) au-dessus du sol
          mnh: {
            type: "raster", tiles: [wmts("IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW", "image/png")],
            tileSize: 256, maxzoom: 18, attribution: ATTRIBUTION_IGN,
          },
          panoramax: {
            type: "vector", tiles: [tilesUrl()], minzoom: 0, maxzoom: 15, attribution: ATTRIBUTION_PANORAMAX,
          },
          mesures: { type: "geojson", data: EMPTY },
          precedents: { type: "geojson", data: EMPTY },  // résultats de la session précédente (showPrevious)
          couche: { type: "geojson", data: EMPTY },  // couche importée (showOverlay)
          pr: { type: "geojson", data: EMPTY },
          // Cadastre (#36, réglage « Cadastre sur la carte », voir setCadastre) : Parcellaire Express en tuiles vectorielles
          // (parcelles dès le zoom 15 ; bâtiments, bornes et points d'étiquette dès le zoom 17), nettes à tout zoom
          cadastre: { type: "vector", tiles: [`${GEOPF}/tms/1.0.0/PCI/{z}/{x}/{y}.pbf`], minzoom: 5, maxzoom: 19, attribution: ATTRIBUTION_IGN },
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
          { id: "mnh", type: "raster", source: "mnh", layout: { visibility: "none" } },
          // Cadastre, sur le fond et sous le filaire (couleurs du Parcellaire Express de l'IGN) : parcelles numérotées teintées (le
          // domaine public, voirie et cours d'eau, n'en a pas : sans teinte), bâtiments, limites des parcelles (pas celles des feuilles)
          {
            id: "cadastre-parcelles", type: "fill", source: "cadastre", "source-layer": "parcelle", minzoom: CADASTRE_MINZOOM, layout: { visibility: "none" },
            paint: { "fill-color": "#ff8000", "fill-opacity": 0.12 },
          },
          {
            id: "cadastre-batiments", type: "fill", source: "cadastre", "source-layer": "batiment", layout: { visibility: "none" },
            paint: { "fill-color": "#c17d73", "fill-opacity": 0.45, "fill-outline-color": "#b580ff" },
          },
          {
            id: "cadastre", type: "line", source: "cadastre", "source-layer": "parcelle", minzoom: CADASTRE_MINZOOM, layout: { visibility: "none" },
            paint: { "line-color": "#ff8000", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.6, 18, 1.6, 21, 2.5] },
          },
          // Parcelle où se tient la caméra, en jaune, et parcelle visée : la première que coupe la ligne de cap, à moins de
          // CADASTRE_VISEE m, en vert (aimCadastre)
          {
            id: "cadastre-camera-fond", type: "fill", source: "cadastre", "source-layer": "parcelle", minzoom: CADASTRE_MINZOOM,
            layout: { visibility: "none" }, filter: ["==", ["get", "idu"], ""], paint: { "fill-color": SOUS_CAMERA, "fill-opacity": 0.3 },
          },
          {
            id: "cadastre-camera", type: "line", source: "cadastre", "source-layer": "parcelle", minzoom: CADASTRE_MINZOOM,
            layout: { visibility: "none", "line-join": "round" }, filter: ["==", ["get", "idu"], ""],
            paint: { "line-color": SOUS_CAMERA, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 2, 18, 3.5, 21, 5] },
          },
          {
            id: "cadastre-vise-fond", type: "fill", source: "cadastre", "source-layer": "parcelle", minzoom: CADASTRE_MINZOOM,
            layout: { visibility: "none" }, filter: ["==", ["get", "idu"], ""], paint: { "fill-color": VISEE, "fill-opacity": 0.3 },
          },
          {
            id: "cadastre-vise", type: "line", source: "cadastre", "source-layer": "parcelle", minzoom: CADASTRE_MINZOOM,
            layout: { visibility: "none", "line-join": "round" }, filter: ["==", ["get", "idu"], ""],
            paint: { "line-color": VISEE, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 2, 18, 3.5, 21, 5] },
          },
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
          {
            id: "cadastre-bornes", type: "circle", source: "cadastre", "source-layer": "borne_limite_propriete", minzoom: CADASTRE_BORNES_ZOOM,
            layout: { visibility: "none" },
            paint: { "circle-color": "#ffffff", "circle-radius": 3, "circle-stroke-color": "#ff4fd8", "circle-stroke-width": 1.5 },
          },
          // Section et numéro de chaque parcelle, à son point d'étiquette (localisant) : image dessinée à la demande
          // (parcelImage), de taille fixe à l'écran ; celles qui se chevauchent sont masquées
          {
            id: "cadastre-sections", type: "symbol", source: "cadastre", "source-layer": "localisant", minzoom: CADASTRE_SECTIONS_ZOOM,
            layout: { visibility: "none", "icon-image": ["concat", "parcelle:", ["get", "section"], "|", ["get", "numero"]], "icon-padding": 1 },
          },
          // Couche importée (GeoJSON) : couleur de chaque objet (Couche.style), sous les mesures
          {
            id: "couche-traits", type: "line", source: "couche", filter: ["!=", ["geometry-type"], "Point"],
            paint: { "line-color": ["get", "_couleur"], "line-width": 2.5 },
          },
          {
            id: "couche-points", type: "circle", source: "couche", filter: ["==", ["geometry-type"], "Point"],
            paint: { "circle-color": ["get", "_couleur"], "circle-radius": 5, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
          },
          // Résultats de la session précédente, en lecture seule : gris, sous ceux de la session
          {
            id: "precedents-traits", type: "line", source: "precedents", filter: ["==", ["geometry-type"], "LineString"],
            paint: { "line-color": "#757575", "line-width": 3, "line-dasharray": [2, 1] },
          },
          {
            id: "precedents-points", type: "circle", source: "precedents", filter: ["==", ["geometry-type"], "Point"],
            paint: { "circle-color": "#757575", "circle-opacity": 0.6, "circle-radius": 5,
              "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 },
          },
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
      if (e.id.startsWith("parcelle:") && !map.hasImage(e.id)) map.addImage(e.id, parcelImage(e.id.slice("parcelle:".length)), { pixelRatio: 2 });
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

  /** Étiquette d'une parcelle, "section|numéro" : section ("0C" : « C », zéros de tête retirés comme sur le plan) au-dessus
   * du numéro, même police, violet des numéros du Parcellaire Express, liseré blanc (dessinée au double). */
  function parcelImage(spec) {
    const [section, number] = spec.split("|");
    // 13,75 px : 25 % de plus que les 11 px d'abord retenus (lisibilité)
    const lines = [section.replace(/^0+(?=.)/, ""), number], scale = 2, font = `600 ${13.75 * scale}px sans-serif`, line = 16 * scale;
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
    ctx.font = font;
    canvas.width = Math.ceil(Math.max(...lines.map((t) => ctx.measureText(t).width))) + 6 * scale;
    canvas.height = line * lines.length + 2 * scale;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#6a00ff";
    lines.forEach((t, i) => {
      ctx.strokeText(t, canvas.width / 2, scale + line * (i + 0.5));
      ctx.fillText(t, canvas.width / 2, scale + line * (i + 0.5));
    });
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
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
    const bold = `700 ${12 * scale}px Inter, sans-serif`, italic = `italic 700 ${12 * scale}px Inter, sans-serif`;
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
    if (name === "osm") name = "ofm";  // OpenStreetMap France (images), remplacé par OpenFreeMap le 14/11/2026
    if (!BACKGROUNDS.includes(name)) name = "plan";  // fond mémorisé inconnu
    const vector = name === "ofm" ? "ofm" : name === "plan" && mapOptions.vectorPlan ? "planv" : null;
    for (const [key, base] of Object.entries(vectorBases)) {
      for (const id of base.ids) map.setLayoutProperty(id, "visibility", key === vector ? "visible" : "none");
    }
    if (vector) loadVector(map, vector, () => vectorShown === vector);
    vectorShown = vector;
    for (const id of BACKGROUNDS) {
      if (id === "noms" || id === "ofm" || (id === "plan" && vector)) {  // pas une couche d'images : l'orthophoto et les noms par-dessus
        if (id === "plan") map.setLayoutProperty(id, "visibility", "none");
        continue;
      }
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
    loadMilestones(map);
  }

  let vectorShown = null;  // fond vectoriel affiché (clé de VECTOR_BASES), ou null
  const vectorBases = {};  // clé -> { ids : couches ajoutées, loading }
  /** Ajoute (une fois) les couches d'un fond vectoriel, au-dessus des fonds en images et sous tout le reste ; shown() :
   * encore choisi à leur arrivée. */
  function loadVector(map, key, shown) {
    const base = vectorBases[key] ??= { ids: [], loading: null };
    base.loading ??= (async () => {
      try {
        const def = VECTOR_BASES[key], style = await (await fetch(def.style)).json();
        map.addSprite(key, typeof style.sprite === "string" ? style.sprite : style.sprite[0].url);
        // Pictogrammes nommés par le style mais absents de ses images (OpenFreeMap : bicycle_parking, gate…) : image vide
        map.on("styleimagemissing", ({ id }) => {
          if (id.startsWith(`${key}:`) && !map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
        });
        const sources = {};
        for (const [name, source] of Object.entries(style.sources)) {
          if (source.type !== "vector") continue;  // relief ombré des petites échelles (OpenFreeMap) : sans
          const id = `${key}-${name}`;
          map.addSource(id, source.tiles ? { type: "vector", tiles: source.tiles, scheme: source.scheme, maxzoom: def.maxzoom ?? 14, attribution: def.attribution }
            : { type: "vector", url: source.url, attribution: def.attribution });
          sources[name] = id;
        }
        /** Nom d'image du style préfixé de la clé : nom, nom à jetons ("{class}_11") ou expression (sorties d'un step
         * ou d'un interpolate sur le zoom traitées une à une : le zoom n'est permis qu'au sommet). */
        const prefixed = (image) => {
          if (typeof image === "string") {
            const parts = image.split(/\{([^}]+)\}/).map((part, i) => (i % 2 ? ["to-string", ["get", part]] : part)).filter((part) => part !== "");
            if (!parts.length) return "";
            if (parts.length === 1 && typeof parts[0] === "string") return `${key}:${image}`;
            image = parts.length === 1 ? parts[0] : ["concat", ...parts];
          } else if (Array.isArray(image) && image[0] === "step") {
            return [...image.slice(0, 2), prefixed(image[2]), ...image.slice(3).map((v, i) => (i % 2 ? prefixed(v) : v))];
          } else if (image?.stops) return { ...image, stops: image.stops.map(([z, v]) => [z, prefixed(v)]) };
          return ["let", "i", image, ["case", ["==", ["to-string", ["var", "i"]], ""], "", ["concat", `${key}:`, ["to-string", ["var", "i"]]]]];
        };
        for (const layer of style.layers) {
          if (layer.type !== "background" && !sources[layer.source]) continue;
          const layout = { ...layer.layout, visibility: shown() ? "visible" : "none" };
          if (layout["text-size"] != null || layer.type === "symbol") layout["text-size"] = scaledSize(layout["text-size"] ?? 16, mapOptions.textScale);
          if (Array.isArray(layout["text-font"]) && def.font) layout["text-font"] = layout["text-font"].map((f) => (typeof f === "string" ? def.font(f) : f));
          if (layout["icon-image"] != null) layout["icon-image"] = prefixed(layout["icon-image"]);
          const paint = { ...layer.paint };  // motifs (cimetières, marais du Plan IGN) : images du même style
          for (const name of ["fill-pattern", "line-pattern"]) if (paint[name] != null) paint[name] = prefixed(paint[name]);
          const id = `${key}-${layer.id}`;
          map.addLayer({ ...layer, id, ...(layer.source && { source: sources[layer.source] }), layout, paint }, "cadastre-parcelles");
          base.ids.push(id);
        }
      } catch (error) {
        console.warn(`Fond vectoriel ${key} indisponible :`, error);
        base.loading = null;  // nouvel essai au prochain choix du fond
      }
    })();
  }

  /** Affiche ou masque le filaire Panoramax (séquences et photos). */
  function setNetworkVisible(map, shown) {
    for (const id of NETWORK_LAYERS) map.setLayoutProperty(id, "visibility", shown ? "visible" : "none");
  }

  let namesShown = false;
  let namesIds = [];  // couches des noms, une fois chargées
  // biome-ignore lint/correctness/noUnusedVariables: lue par ??= (chargement une seule fois)
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

  // Points de repère (PR) des routes, avec le fond « orthophoto avec noms » : BD TOPO, zone affichée, à partir de PR_MINZOOM ; leur
  // étiquette (marqueur HTML, sans police à charger) à partir de PR_LABEL_ZOOM ---------------

  const PR_MINZOOM = 13;
  const PR_LABEL_ZOOM = PR_MINZOOM;  // bornes dès que les points paraissent
  const prLabels = [];
  let prTimer = null, prAsked = 0, prKey = "";
  let milestonesOn = true;  // réglage « Bornes des PR sur la carte » (setMilestones)

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

  // Cadastre : parcelles dès CADASTRE_MINZOOM, bornes de limite de propriété et étiquettes dès CADASTRE_BORNES_ZOOM (nombreuses ;
  // tuiles vectorielles du PCI : ni bornes ni étiquettes avant le zoom 17)
  const CADASTRE_MINZOOM = 15, CADASTRE_BORNES_ZOOM = 17, CADASTRE_SECTIONS_ZOOM = 17;
  let cadastreOn = false, cadastreFollow = false;

  /** Cadastre affiché ou non sur la carte (réglage « Cadastre »). */
  function setCadastre(map, on) {
    cadastreOn = on;
    // pas whenLoaded (voir setMilestones) : « load » peut être passé alors que le style se dit « pas chargé »
    const apply = () => {
      for (const id of ["cadastre-parcelles", "cadastre", "cadastre-camera-fond", "cadastre-camera", "cadastre-vise-fond", "cadastre-vise", "cadastre-batiments", "cadastre-bornes", "cadastre-sections"]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      if (!cadastreFollow) {
        cadastreFollow = true;
        // tuiles du cadastre arrivées (zoom, déplacement) : parcelle visée recherchée de nouveau
        map.on("sourcedata", (e) => { if (e.sourceId === "cadastre" && e.isSourceLoaded) { sceneCache = null; aimCadastre(map); } });
      }
      aimCadastre(map);
    };
    try { apply(); } catch { map.once("load", apply); }
  }

  // Parcelle visée : la première que coupe la ligne de cap en partant de la caméra (celle où se tient la caméra, cour ou
  // chemin privé, écartée : elle est allumée à part, en jaune), jusqu'à CADASTRE_VISEE m : au-delà, la photo ne montre plus assez la parcelle pour s'en servir
  // (limites du plan à 1,5 m près en Côte-d'Or, voir CADASTRE_DECALAGE). Recherchée sur les tuiles chargées, à chaque
  // rotation de la vue (une fois par image au plus).
  const CADASTRE_VISEE = 50;
  // aimListener : averti de la parcelle visée ({ idu, section, numero, at : [lon, lat] du milieu de sa partie vue
  // directement, entre ses limites gauche et droite (parcelMiddle) }, ou null), à chaque changement de parcelle visée ou de caméra : ce point ne bouge pas
  // quand la vue tourne dans la même parcelle
  let aimFrame = 0, aimedKey = "", aimedNow = null, aimListener = null;
  function aimCadastre(map) {
    if (aimFrame) return;
    aimFrame = requestAnimationFrame(() => {
      aimFrame = 0;
      const { aimed, own, scene } = cadastreOn && map.getZoom() >= CADASTRE_MINZOOM ? aimedParcel(map) : { aimed: null, own: "" };
      const key = `${aimed?.idu}|${own}|${lastView?.[0]?.join(",") || ""}`;
      if (key === aimedKey || !map.getLayer("cadastre-vise")) return;
      aimedKey = key;
      for (const id of ["cadastre-vise-fond", "cadastre-vise"]) map.setFilter(id, ["==", ["get", "idu"], aimed?.idu || ""]);
      for (const id of ["cadastre-camera-fond", "cadastre-camera"]) map.setFilter(id, ["==", ["get", "idu"], own]);
      if (aimed) aimed.at = parcelMiddle(scene, lastView[1], aimed.idu);  // une fois par parcelle et position de caméra
      aimedNow = aimed;
      aimListener?.(aimed);
    });
  }
  /** Parcelle visée (voir aimCadastre), ou null. */
  const aimedParcelNow = () => aimedNow;
  /** Parcelles de la vue (lastView) : { aimed : visée, à moins de CADASTRE_VISEE m ({ idu, section, numero, at }, ou null),
   * own : idu de celle où se tient la caméra, ou "" }. La parcelle de la caméra se lit aussi sans cap (Bird Eye). */
  // Scène des parcelles gardée tant que la caméra ne bouge pas et qu'aucune tuile du cadastre n'arrive (sourcedata) : une
  // rotation de la vue ne refait que la visée (firstParcel), pas la lecture de toutes les parcelles chargées à chaque image
  let sceneCache = null;
  function aimedParcel(map) {
    const [lonlat, heading] = lastView || [];
    if (!lonlat) return { aimed: null, own: "" };
    const key = lonlat.join(",");
    if (sceneCache?.key !== key) sceneCache = { key, scene: parcelScene(map, lonlat) };
    const scene = sceneCache.scene, own = [...scene.around][0] || "";
    const hit = heading == null ? null : firstParcel(scene, heading);
    if (!hit) return { aimed: null, own };
    const { idu, t, props } = hit;
    return { own, scene, aimed: { idu, section: String(props.section ?? "").replace(/^0+(?=.)/, ""),
      numero: String(props.numero ?? ""), at: scene.lonlatAt(heading, t) } };
  }
  /** Côtés des parcelles chargées proches de la caméra (lonlat), en m depuis elle (est, nord), et parcelles où elle se tient
   * (around) ; lonlatAt(cap, t) : point à t m dans ce cap. */
  function parcelScene(map, lonlat) {
    const kx = 111320 * Math.cos(lonlat[1] * Math.PI / 180), ky = 111320;  // m par degré (à 0,3 % près : sans effet ici)
    const around = new Set(), segments = [];
    for (const f of map.querySourceFeatures("cadastre", { sourceLayer: "parcelle" })) {
      const idu = f.properties?.idu, g = f.geometry;
      if (!idu || !g) continue;
      const polygons = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const rings of polygons) {
        const local = rings.map((ring) => ring.map(([lon, lat]) => [(lon - lonlat[0]) * kx, (lat - lonlat[1]) * ky]));
        const xs = local[0].map((p) => p[0]), ys = local[0].map((p) => p[1]);
        const gap = Math.hypot(Math.max(0, Math.min(...xs), -Math.max(...xs)), Math.max(0, Math.min(...ys), -Math.max(...ys)));
        if (gap > CADASTRE_VISEE) continue;  // tout entière au-delà de la portée
        let inside = false;
        for (const ring of local) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, ay] = ring[j], [bx, by] = ring[i];
            if ((ay > 0) !== (by > 0) && 0 < ax + (bx - ax) * (0 - ay) / (by - ay)) inside = !inside;  // caméra dedans ?
            segments.push({ idu, props: f.properties, ax, ay, ex: bx - ax, ey: by - ay });
          }
        }
        if (inside) around.add(idu);
      }
    }
    const lonlatAt = (heading, t) => [lonlat[0] + t * Math.sin(heading * Math.PI / 180) / kx,
      lonlat[1] + t * Math.cos(heading * Math.PI / 180) / ky];
    return { around, segments, lonlatAt, kx, ky };
  }
  /** Première parcelle que coupe la visée au cap heading, à CADASTRE_VISEE m au plus, hors celles de la caméra :
   * { idu, t (m), props }, ou null. */
  function firstParcel(scene, heading) {
    const dx = Math.sin(heading * Math.PI / 180), dy = Math.cos(heading * Math.PI / 180);
    let best = null;
    for (const { idu, props, ax, ay, ex, ey } of scene.segments) {
      // croisement du rayon (t dx, t dy), t ≥ 0, avec le côté a + u e, 0 ≤ u ≤ 1
      const den = dx * ey - dy * ex;
      if (!den || scene.around.has(idu)) continue;
      const t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den;
      if (t >= 0 && t <= CADASTRE_VISEE && u >= 0 && u <= 1 && t < (best?.t ?? Infinity)) best = { idu, t, props };
    }
    return best;
  }
  /** Milieu de la partie de la parcelle idu vue directement de la caméra, vue au cap heading : [lon, lat] du milieu du
   * segment qui joint ses deux limites latérales, là où la visée cesse de la rencontrer en première (parcelle voisine,
   * domaine public, ou rien à portée), cherchées à 0,01° près ; chaque limite prise sur le bord de la parcelle. */
  function parcelMiddle(scene, heading, idu) {
    const sees = (cap) => firstParcel(scene, cap)?.idu === idu;
    const [a, b] = [-1, 1].map((side) => {
      let good = heading, bad = null;
      for (let turn = 1; turn <= 180; turn++) {
        if (!sees(heading + side * turn)) { bad = heading + side * turn; break; }
        good = heading + side * turn;
      }
      while (bad != null && Math.abs(bad - good) > 0.01) {  // limite entre le dernier cap qui la voit et le premier qui ne la voit plus
        const mid = (good + bad) / 2;
        if (sees(mid)) good = mid; else bad = mid;
      }
      const t = firstParcel(scene, good).t;
      return [t * Math.sin(good * Math.PI / 180), t * Math.cos(good * Math.PI / 180)];
    });
    const [x, y] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return scene.lonlatAt(Math.atan2(x, y) * 180 / Math.PI, Math.hypot(x, y));
  }

  function showMilestones(map) {
    map.on("moveend", () => {
      clearTimeout(prTimer);
      prTimer = setTimeout(() => loadMilestones(map), 300);
    });
    whenLoaded(map, () => loadMilestones(map));
  }

  /** Points de repère et bornes affichés ou non, sur tous les fonds. */
  function setMilestones(map, on) {
    milestonesOn = on;
    loadMilestones(map);  // pas whenLoaded : style « pas chargé » pendant le chargement des tuiles, « load » déjà passé
  }

  async function loadMilestones(map) {
    const zoom = map.getZoom();
    const b = map.getBounds();
    // Zone chargée arrondie (et un peu élargie) : petits déplacements sans nouvelle requête
    const r = (v, up) => (up ? Math.ceil(v * 200) : Math.floor(v * 200)) / 200;
    const box = [r(b.getWest(), false), r(b.getSouth(), false), r(b.getEast(), true), r(b.getNorth(), true)];
    // Tous les fonds, selon le réglage : décoché, ni points ni bornes (pas de requête non plus)
    const key = milestonesOn && zoom >= PR_MINZOOM ? box.join(",") + (zoom >= PR_LABEL_ZOOM ? "+" : "") : "";
    if (key === prKey) return;
    prKey = key;
    const ticket = ++prAsked;
    let features = [], sections = new Map();
    if (key) {
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

  /** Couche importée (GeoJSON en WGS 84, properties._couleur et _etiquette_carte), ou null : retirée.
   * Étiquettes à partir du zoom OVERLAY_LABEL_ZOOM, sur les objets de la vue (OVERLAY_LABEL_MAX au plus). */
  const OVERLAY_LABEL_ZOOM = 16, OVERLAY_LABEL_MAX = 200;
  let overlay = null, overlayLabels = [], overlayBound = false;
  function showOverlay(map, geojson) {
    overlay = geojson;
    const set = () => map.getSource("couche")?.setData(geojson || EMPTY);
    set();
    if (!map.loaded()) map.once("load", set);
    if (!overlayBound) {
      overlayBound = true;
      map.on("moveend", () => overlayLabelsFor(map));
    }
    overlayLabelsFor(map);
  }
  function overlayLabelsFor(map) {
    for (const marker of overlayLabels.splice(0)) marker.remove();
    if (!overlay || map.getZoom() < OVERLAY_LABEL_ZOOM) return;
    const bounds = map.getBounds();
    // Comme dans la visionneuse : de la plus proche de la photo affichée (sinon du centre de la carte)
    // à la plus lointaine
    const from = lastView?.[0] || map.getCenter().toArray();
    const found = [];
    for (const f of overlay.features) {
      const text = f.properties._etiquette_carte;
      if (!text) continue;
      const positions = (c) => (typeof c[0] === "number" ? [c.slice(0, 2)] : c.flatMap(positions));  // x, y (z ignoré)
      const pts = positions(f.geometry.coordinates);
      const at = pts[Math.floor(pts.length / 2)];
      if (!at || !bounds.contains(at)) continue;
      found.push({ f, at, d: Math.min(...pts.map((p) => metresBetween(p, from))) });
    }
    found.sort((a, b) => a.d - b.d);
    // Axes des voies BD TOPO chargées, en pixels : les étiquettes s'en écartent (awayFromRoad)
    const axes = [];
    for (const road of map.getSource("voies") ? map.querySourceFeatures("voies", { sourceLayer: "troncon_de_route" }) : []) {
      const g = road.geometry;
      for (const line of g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : []) {
        const px = line.map((c) => map.project(c));
        for (let i = 1; i < px.length; i++) axes.push([px[i - 1], px[i]]);
      }
    }
    for (const { f, at } of found.slice(0, OVERLAY_LABEL_MAX)) {
      const element = document.createElement("div");  // ancre : MapLibre place l'élément, l'étiquette s'y décale
      const label = Object.assign(document.createElement("div"), { className: "etiquette couche", textContent: f.properties._etiquette_carte });
      label.style.color = Couche.clair(f.properties._couleur);
      element.append(label);
      overlayLabels.push(new maplibregl.Marker({ element, ...awayFromRoad(map.project(at), axes) }).setLngLat(at).addTo(map));
    }
    requestAnimationFrame(() => declutterOverlayLabels(map));
  }

  /**
   * Place d'une étiquette de la couche au point p (pixels) : du côté opposé à l'axe de voie le plus
   * proche (segments en pixels, à ROAD_REACH px au plus), écartée de ROAD_GAP px perpendiculairement à
   * lui ; sans voie proche (ou hors du zoom des voies), au-dessus de la pastille. Options d'un Marker.
   */
  const ROAD_REACH = 60, ROAD_GAP = 12;
  function awayFromRoad(p, axes) {
    let best = null;
    for (const [a, b] of axes) {
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      const qx = a.x + t * dx, qy = a.y + t * dy, d = Math.hypot(p.x - qx, p.y - qy);
      if (d < ROAD_REACH && (!best || d < best.d)) best = { d, dx, dy, nx: p.x - qx, ny: p.y - qy };
    }
    if (!best) return { offset: [0, -20] };
    // Sur l'axe même : côté gauche de la voie, au hasard du sens du tronçon
    let [nx, ny] = best.d > 0.5 ? [best.nx / best.d, best.ny / best.d] : [best.dy, -best.dx].map((v) => v / Math.hypot(best.dx, best.dy));
    if (!Number.isFinite(nx)) [nx, ny] = [0, -1];
    // Ancre du côté du point : l'étiquette s'étend loin de la voie
    const v = Math.abs(ny) > 0.38 ? (ny > 0 ? "top" : "bottom") : "", h = Math.abs(nx) > 0.38 ? (nx > 0 ? "left" : "right") : "";
    return { anchor: [v, h].filter(Boolean).join("-"), offset: [nx * ROAD_GAP, ny * ROAD_GAP] };
  }

  /** Étiquettes de la couche sur la carte, dans l'ordre de proximité : chacune remontée au-dessus des
   * étiquettes déjà placées (mesures comprises), masquée s'il faudrait la remonter de plus de
   * OVERLAY_MAX_LIFT fois sa hauteur (comme dans la visionneuse, voir app.js declutterLabels). */
  function declutterOverlayLabels(map) {
    const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom + 2 && a.bottom + 2 > b.top;
    const placed = labels.map((m) => m.getElement().getBoundingClientRect()).filter((r) => r.width);
    for (const marker of overlayLabels) {
      const label = marker.getElement().firstChild;
      label.style.transform = "";
      label.style.visibility = "";
      const rect = label.getBoundingClientRect(), limit = OVERLAY_MAX_LIFT * rect.height;
      let shift = 0, r = rect;
      for (let other = placed.find((p) => hit(r, p)); other && -shift <= limit; other = placed.find((p) => hit(r, p))) {
        shift -= r.bottom + 2 - other.top;
        r = { left: rect.left, right: rect.right, top: rect.top + shift, bottom: rect.bottom + shift };
      }
      if (-shift > limit) {
        label.style.visibility = "hidden";
        continue;
      }
      label.style.transform = `translateY(${shift}px)`;
      placed.push(r);
    }
  }
  const OVERLAY_MAX_LIFT = 1.5;


  /** Résultats de la session précédente (export GeoJSON gardé), ou null : retirés. */
  function showPrevious(map, geojson) {
    const set = () => map.getSource("precedents")?.setData(geojson || EMPTY);
    set();
    if (!map.loaded()) map.once("load", set);  // avant le chargement, la source peut être refaite vide
  }

  function showMeasures(map, geojson) {
    shownMeasures = geojson;
    map.getSource("mesures")?.setData(geojson);
    for (const marker of labels.splice(0)) marker.remove();
    sublabels.length = 0;
    stacked.length = 0;
    labelMap = map;
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
        if (feature.geometry.type === "LineString") {  // largeur, distance : à côté du trait (voir besideLine)
          const line = feature.geometry.coordinates;
          lineEnds.set(marker, [line[0], line[line.length - 1]]);
        }
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
  const LINE_GAP = 5;  // px entre le trait et le bord de l'étiquette posée à côté de lui
  const CROSS_RADIUS = 10;  // px : demi-taille de la croix d'un point de mesure, et marge
  const stacked = [];
  const lineEnds = new WeakMap();  // étiquette d'un trait -> ses deux bouts [lon, lat]
  let labelMap = null;

  /** Placement d'une étiquette : direction (vecteur unitaire à l'écran) et écart au point. Étiquette
   * d'un trait (largeur, distance) : horizontale, à côté de son milieu, dans la direction
   * perpendiculaire au trait (côté haut), juste assez loin pour ne toucher ni le trait ni ses
   * bouts ; posée au-dessus du milieu, elle cachait le bout d'un trait court ou oblique. */
  function besideLine(marker) {
    const element = marker.getElement();
    const ends = lineEnds.get(marker);
    if (!ends || !labelMap) return { dir: [0, labelSide(element)], gap: LABEL_OFFSET };
    const pa = labelMap.project(ends[0]), pb = labelMap.project(ends[1]);
    const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (length < 1) return { dir: [0, -1], gap: LABEL_OFFSET };
    let nx = -(pb.y - pa.y) / length, ny = (pb.x - pa.x) / length;
    if (ny > 0 || (ny === 0 && nx < 0)) [nx, ny] = [-nx, -ny];  // vers le haut (ou la droite)
    const w = element.offsetWidth / 2, h = element.offsetHeight / 2;
    let gap = w * Math.abs(nx) + h * Math.abs(ny) + LINE_GAP;
    // Trait court : écartée encore tant qu'elle touche la croix d'un bout
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    const touches = (p) => Math.abs(p.x - mx - nx * gap) < w + CROSS_RADIUS && Math.abs(p.y - my - ny * gap) < h + CROSS_RADIUS;
    while (gap < 80 && (touches(pa) || touches(pb))) gap += 2;
    return { dir: [nx, ny], gap };
  }

  /** Sens de l'étiquette : -1 au-dessus (mesures), 1 dessous (points triangulés). */
  const labelSide = (element) => (element.classList.contains("tri-point") ? 1 : -1);
  const labelOffset = (element) => [0, labelSide(element) * LABEL_OFFSET];

  function declutter() {
    const placed = [];
    for (const marker of stacked) {
      const element = marker.getElement();
      const { dir, gap } = besideLine(marker);
      marker.setOffset([dir[0] * gap, dir[1] * gap]);
      let rect = element.getBoundingClientRect();
      for (let k = 1; k <= 10 && placed.some((p) => overlaps(p, rect)); k++) {
        const d = gap + k * (rect.height + 2);
        marker.setOffset([dir[0] * d, dir[1] * d]);
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

  /** Image de la carte telle qu'affichée (vue Bird Eye, traits des mesures, tracé en cours), avec par-dessus ce que la carte
   * pose en HTML : étiquettes des mesures et longueur en cours (à leur place, couleur, police et inclinaison), échelle et
   * attribution des sources. Promesse d'un PNG (Blob). */
  async function capture(map) {
    const canvas = map.getCanvas(), container = map.getContainer(), box = container.getBoundingClientRect();
    // tampon WebGL lu pendant un rendu (sinon vide)
    const out = await new Promise((resolve) => {
      map.once("render", () => {
        const copy = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height });
        copy.getContext("2d").drawImage(canvas, 0, 0);
        resolve(copy);
      });
      map.triggerRepaint();
    });
    const g = out.getContext("2d"), k = canvas.width / container.clientWidth;
    const angleOf = (el) => {  // inclinaison cumulée (setRotation des marqueurs, transform CSS)
      let angle = 0;
      for (let e = el; e && e !== container; e = e.parentElement) {
        const t = getComputedStyle(e).transform;
        if (t && t !== "none") { const m = new DOMMatrix(t); angle += Math.atan2(m.b, m.a); }
      }
      return angle;
    };
    const draw = (el, text = el.textContent) => {
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      if (!text || st.display === "none" || st.visibility === "hidden" || !r.width) return;
      if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) return;
      const w = el.offsetWidth * k, h = el.offsetHeight * k;
      g.save();
      g.translate(((r.left + r.right) / 2 - box.left) * k, ((r.top + r.bottom) / 2 - box.top) * k);
      g.rotate(angleOf(el));
      g.fillStyle = st.backgroundColor;
      g.beginPath();
      g.roundRect(-w / 2, -h / 2, w, h, (parseFloat(st.borderTopLeftRadius) || 0) * k);
      g.fill();
      g.fillStyle = st.color;
      g.font = `${st.fontStyle} ${st.fontWeight} ${parseFloat(st.fontSize) * k}px ${st.fontFamily}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, 0, 0);
      g.restore();
    };
    container.querySelectorAll(".maplibregl-marker .etiquette, .maplibregl-marker.etiquette, .dessus-etiquette").forEach((el) => draw(el));
    // échelle : trait encadré et sa longueur, comme MapLibre
    const scale = container.querySelector(".maplibregl-ctrl-scale");
    if (scale) {
      const r = scale.getBoundingClientRect(), x = (r.left - box.left) * k, y = (r.top - box.top) * k, w = r.width * k, h = r.height * k;
      g.fillStyle = "rgba(255, 255, 255, 0.75)";
      g.fillRect(x, y, w, h);
      g.strokeStyle = "#333";
      g.lineWidth = 2 * k;
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x, y + h); g.lineTo(x + w, y + h); g.lineTo(x + w, y);
      g.stroke();
      g.fillStyle = "#333";
      g.font = `${10 * k}px sans-serif`;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(scale.textContent, x + 4 * k, y + h / 2);
    }
    // sources (licences) : en bas à droite
    const credit = (container.querySelector(".maplibregl-ctrl-attrib-inner")?.textContent || "").trim();
    if (credit) {
      g.font = `${11 * k}px sans-serif`;
      const pad = 4 * k, tw = g.measureText(credit).width;
      g.fillStyle = "rgba(255, 255, 255, 0.8)";
      g.fillRect(out.width - tw - 2 * pad, out.height - 16 * k, tw + 2 * pad, 16 * k);
      g.fillStyle = "#333";
      g.textAlign = "right";
      g.textBaseline = "middle";
      g.fillText(credit, out.width - pad, out.height - 8 * k);
    }
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
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
      lastView = null;
      if (cadastreOn) aimCadastre(map);  // plus de vue : plus de parcelle visée
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
        <path d="M-8 0H8M0 -8V8" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
        <path d="M-8 0H8M0 -8V8" stroke="${CURSEUR}" stroke-width="3" stroke-linecap="round"/></svg>`;  // croix : pas une pastille de la couche
    }
    viewMarker.setLngLat(lonlat).setRotation(heading ?? 0);
    if (!viewMarker._map) viewMarker.addTo(map);
    if (cadastreOn) aimCadastre(map);
  }
  let lastView = null;

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
   * Photo (fiche STAC) la plus proche du point, dans un rayon de radius m, sinon adapté à l'échelle (10 à 150 m),
   * parmi celles qui passent le filtre `accept` (fiche -> booléen).
   */
  async function nearestPhoto(map, lng, lat, accept = () => true, radius = null) {
    return (await photosNear(map, lng, lat, accept, radius))[0] || null;
  }

  /** Photos qui passent le filtre `accept` autour du point, de la plus proche à la plus lointaine,
   * dans un carré de `radius` m de demi-côté (par défaut adapté à l'échelle : 10 à 150 m) ; limit : photos demandées
   * au plus (SEARCH_LIMIT par défaut). */
  async function photosNear(map, lng, lat, accept = () => true, radius = null, limit = SEARCH_LIMIT) {
    radius ??= Math.min(150, Math.max(10, 15 * metresPerPixel(map, lat)));
    const dlat = radius / 111320;
    const dlon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    const bbox = [lng - dlon, lat - dlat, lng + dlon, lat + dlat].map((v) => v.toFixed(7)).join(",");
    const search = async (limit) => {
      const response = await fetch(`${apiUrl}/search?bbox=${bbox}&limit=${limit}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const features = (await response.json()).features || [];
      const found = features.filter((f) => accept(f))
        .map((feature) => ({ feature, d: metresBetween([lng, lat], feature.geometry.coordinates) }))
        .sort((a, b) => a.d - b.d).map((f) => f.feature);
      return { found, full: features.length >= limit };
    };
    // 50 photos suffisent d'ordinaire ; si le filtre les écarte toutes et qu'il y en a d'autres
    // (réponse pleine, zone dense), une seconde recherche plus large (lourde : faite seulement là)
    let { found, full } = await search(limit);
    if (!found.length && full) ({ found } = await search(SEARCH_LIMIT_FILTERED));
    return found;
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
    PANORAMAX_API: META_API, GEOPF, OFM_STYLE: VECTOR_BASES.ofm.style, createMap, setBackground, setNetworkVisible, showAdmin, setExpressYear, pcrsAt, instances, setInstance, setFilter,
    showMeasures, showPrevious, showOverlay, showHandles, showView, showMilestones, setMilestones, setCadastre, onAim: (fn) => { aimListener = fn; }, aimedParcel: aimedParcelNow, capture, nearestPhoto, photosNear, photoById, metresBetween, apiUrl: () => apiUrl,
  };
})();
