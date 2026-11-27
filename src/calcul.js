// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Cœur de calcul (py/core/, repris du plugin Visionneuse Panoramax),
// exécuté dans le navigateur par Pyodide, et piloté par py/web_app.py. Les fichiers Python
// sont lus par fetch (liste PY_FILES, vérifiée par tests/test_calculs.py) pendant le chargement de
// Pyodide, puis écrits dans son système de fichiers. Après une mise en ligne (tools/construire.sh),
// leur adresse porte ?v=<commit> (balise version-fichiers d'index.html) : jamais d'anciens fichiers
// mêlés aux nouveaux dans le cache.
//
// Deux Pyodide : celui de la page (mesures, rapide) et un second en arrière-plan (Web Worker)
// pour les calculs lourds sur les photos HD (inclinaison automatique, capture HD), avec numpy
// et Pillow : la page reste fluide pendant ces calculs.

const Calcul = (() => {
  const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
  const PY_ROOT = "/home/pyodide/web";
  // Fichiers Python chargés dans Pyodide, chemins relatifs à py/ : tous ceux de py/ (cœur py/core/ compris)
  const PY_FILES = [
    "core/__init__.py",
    "core/autotilt.py",
    "core/calibration.py",
    "core/capture.py",
    "core/filters.py",
    "core/geometry.py",
    "core/ground.py",
    "core/host.py",
    "core/measures.py",
    "core/metadata.py",
    "core/precision.py",
    "core/relief.py",
    "core/roads.py",
    "core/session.py",
    "core/tools.py",
    "core/triangulation.py",
    "geoid.py",
    "web_app.py",
    "web_chutes.py",
    "web_host.py",
    "web_nez.py",
    "web_pose.py",
    "web_profils.py",
    "web_terrain.py",
    "web_tilt.py",
    "web_worker.py",
  ];

  /** « ?v=<commit> » en ligne (balise version-fichiers remplie par tools/construire.sh), vide en local. */
  function versionSuffix() {
    const v = document.querySelector('meta[name="version-fichiers"]')?.content;
    return v ? `?v=${encodeURIComponent(v)}` : "";
  }

  /** Télécharge en parallèle les fichiers Python : { chemin : texte }. Échec : nom du fichier manquant. */
  async function fetchSources() {
    const suffix = versionSuffix();
    const entries = await Promise.all(PY_FILES.map(async (path) => {
      let response;
      try {
        response = await fetch(`py/${path}${suffix}`);
      } catch (error) {
        throw new Error(`fichier Python illisible : py/${path} (${error})`);
      }
      if (!response.ok) throw new Error(`fichier Python introuvable : py/${path} (HTTP ${response.status})`);
      return [path, await response.text()];
    }));
    return Object.fromEntries(entries);
  }

  // Téléchargement lancé dès le chargement du script, en parallèle de celui de Pyodide ; le rejet est
  // relevé par startCalcul (l'attente ci-dessous évite seulement un rejet « non géré » avant)
  const sourcesPromise = fetchSources();
  sourcesPromise.catch(() => {});

  // Grille du géoïde (RAF20 de l'IGN), servie avec le site : voir py/geoid.py
  const GEOID_FILE = "donnees/fr_ign_RAF20.tif";

  function install(pyodide, sources) {
    for (const [path, source] of Object.entries(sources)) {
      const target = `${PY_ROOT}/${path}`;
      pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
      pyodide.FS.writeFile(target, source);
    }
    pyodide.runPython(`import sys\nsys.path.insert(0, "${PY_ROOT}")`);
  }

  // Arrière-plan : Web Worker de type module (src/worker-calcul.js), qui reçoit de la page les sources
  // Python déjà téléchargées ---------------------------------------------------------------------

  let worker = null;
  const waiting = new Map();  // n° de requête -> { resolve, reject }
  let nextId = 1;

  function startWorker(sources) {
    worker = new Worker(new URL(`src/worker-calcul.js${versionSuffix()}`, document.baseURI), { type: "module" });
    // Chargement raté ou Worker arrêté (mémoire…) : calculs d'arrière-plan indisponibles, et
    // les demandes en cours échouent au lieu d'attendre indéfiniment
    const fail = (error) => {
      console.error("Pyodide d'arrière-plan :", error);
      for (const request of waiting.values()) request.reject(new Error(String(error)));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
    worker.onerror = (event) => fail(event.message || "arrêt du calcul d'arrière-plan");
    worker.onmessage = (event) => {
      const { id, result, error } = event.data;
      if (id === 0) {
        fail(error);
        return;
      }
      const request = waiting.get(id);
      waiting.delete(id);
      if (!request) return;
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    };
    worker.postMessage({ type: "init", pyodide: PYODIDE, root: PY_ROOT, sources });
  }

  function request(message, transfer = []) {
    if (!worker) return Promise.reject(new Error("calculs d'arrière-plan indisponibles"));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  /** Fonction d'un module du cœur, en arrière-plan (voir web_host.run_task) : texte JSON. */
  function runRemote(module, name, args) {
    const plain = Array.from(args, (a) => (a && a.toJs ? a.toJs() : a));
    return request({ type: "call", module, name, args: plain }).catch((error) => {
      console.error(error);
      return "";
    });
  }

  /** Capture HD (voir web_worker.capture) : JPEG en base64 ("" si la photo est illisible). */
  function capture(params, bytes) {
    const p = params;
    return request({
      type: "capture",
      args: [bytes, p.azimuth, p.is360, p.heading, p.pitch, p.vfov, p.photo_hfov, p.up],
    }, [bytes.buffer]);
  }

  /**
   * Charge Pyodide, la grille du géoïde et les fichiers Python de la page, puis crée
   * l'application de mesure. notify : appelée quand une lecture réseau ou un calcul fait
   * avancer une mesure (redessiner). etape : appelée avec l'étape qui commence (animation d'attente, Attente).
   */
  async function startCalcul(notify, apiUrl, etape = () => {}) {
    etape("moteur de calcul");
    const pyodide = await loadPyodide({ indexURL: PYODIDE });
    const sources = await sourcesPromise;
    // Arrière-plan lancé seulement maintenant : son Pyodide (et numpy, Pillow) ne dispute plus au premier le
    // processeur et le réseau ; il existe avant l'application (runRemote), ses demandes attendent qu'il soit prêt
    try {
      startWorker(sources);
    } catch (error) {  // Web Worker interdit : pas d'inclinaison automatique ni de capture HD
      console.error(error);
      worker = null;
    }
    document.dispatchEvent(new Event("calcul-worker"));  // « Image seule » : le bouton se recalcule (photo ouverte avant)
    etape("fichiers du calcul");
    install(pyodide, sources);
    etape("géoïde");
    await pyodide.pyimport("web_host").load_geoid(GEOID_FILE + versionSuffix());
    const webApp = pyodide.pyimport("web_app");
    return webApp.App(notify, worker ? runRemote : null, apiUrl);
  }

  return { startCalcul, capture, hasWorker: () => worker !== null };
})();

export { Calcul };
