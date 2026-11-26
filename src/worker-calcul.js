// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Web Worker du second Pyodide (calculs lourds sur les photos HD : inclinaison automatique, capture
// HD), avec numpy et Pillow. Worker de type module (seul accepté par Pyodide), lancé par src/calcul.js,
// qui lui envoie dans « init » l'adresse de Pyodide, le dossier d'installation et les sources Python
// qu'il a déjà téléchargées (un seul téléchargement pour la page et l'arrière-plan).

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
    let result;
    if (msg.type === "call") {
      // Arguments convertis pour Python seulement ici (la capture prend les siens tels quels),
      // et libérés même si l'appel échoue : ils contiennent la photo
      const args = pyodide.toPy(msg.args);
      try {
        result = worker.call(msg.module, msg.name, args);
      } finally {
        args.destroy();
      }
    } else {
      result = worker.capture(...msg.args);
    }
    self.postMessage({ id: msg.id, result });
  } catch (error) {
    self.postMessage({ id: msg.id, error: String(error) });
  }
};
