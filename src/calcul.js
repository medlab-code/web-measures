// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Cœur de calcul du plugin Visionneuse Panoramax (py/core/, copié par tools/update-core.sh),
// exécuté dans le navigateur par Pyodide, et piloté par py/web_app.py. Les fichiers Python
// sont dans py/sources.js (généré par le même script) : la page s'ouvre aussi en double-
// cliquant sur index.html (file://), où le navigateur interdit de lire les fichiers voisins.
//
// Deux Pyodide : celui de la page (mesures, rapide) et un second en arrière-plan (Web Worker)
// pour les calculs lourds sur les photos HD (inclinaison automatique, capture HD), avec numpy
// et Pillow : la page reste fluide pendant ces calculs.

const Calcul = (() => {
  const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
  const PY_ROOT = "/home/pyodide/web";

  function install(pyodide, sources) {
    for (const [path, source] of Object.entries(sources)) {
      const target = `${PY_ROOT}/${path}`;
      pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
      pyodide.FS.writeFile(target, source);
    }
    pyodide.runPython(`import sys\nsys.path.insert(0, "${PY_ROOT}")`);
  }

  // Arrière-plan ---------------------------------------------------------------------------
  // Code du Web Worker (de type module : seul accepté par Pyodide), transmis dans une adresse
  // data: : un fichier séparé ne se charge pas en file://, ni un Blob (refusé par Chrome).
  function workerMain() {
    let ready = null;
    self.onmessage = async (event) => {
      const msg = event.data;
      if (msg.type === "init") {
        ready = (async () => {
          const { loadPyodide } = await import(msg.pyodide + "pyodide.mjs");
          const pyodide = await loadPyodide({ indexURL: msg.pyodide });
          await pyodide.loadPackage(["numpy", "pillow"]);
          for (const [path, source] of Object.entries(msg.sources)) {
            const target = `${msg.root}/${path}`;
            pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
            pyodide.FS.writeFile(target, source);
          }
          pyodide.runPython(`import sys\nsys.path.insert(0, "${msg.root}")`);
          return { pyodide, worker: pyodide.pyimport("web_worker") };
        })();
        ready.catch((error) => self.postMessage({ id: 0, error: String(error) }));
        return;
      }
      try {
        const { pyodide, worker } = await ready;
        const args = pyodide.toPy(msg.args);
        const result = msg.type === "call" ? worker.call(msg.module, msg.name, args)
          : worker.capture(...msg.args);
        args.destroy();
        self.postMessage({ id: msg.id, result });
      } catch (error) {
        self.postMessage({ id: msg.id, error: String(error) });
      }
    };
  }

  let worker = null;
  const waiting = new Map();  // n° de requête -> { resolve, reject }
  let nextId = 1;

  function startWorker() {
    const code = `(${workerMain.toString()})();`;
    worker = new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`, { type: "module" });
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
    worker.postMessage({ type: "init", pyodide: PYODIDE, root: PY_ROOT, sources: PY_SOURCES });
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
   * avancer une mesure (redessiner).
   */
  async function startCalcul(notify, apiUrl) {
    try {
      startWorker();
    } catch (error) {  // Web Worker interdit : pas d'inclinaison automatique ni de capture HD
      console.error(error);
      worker = null;
    }
    const pyodide = await loadPyodide({ indexURL: PYODIDE });
    install(pyodide, PY_SOURCES);
    await pyodide.pyimport("web_host").load_geoid();
    const webApp = pyodide.pyimport("web_app");
    return webApp.App(notify, worker ? runRemote : null, apiUrl);
  }

  return { startCalcul, capture, runRemote, hasWorker: () => worker !== null };
})();
