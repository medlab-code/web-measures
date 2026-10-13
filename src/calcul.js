// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Cœur de calcul du plugin Visionneuse Panoramax (py/core/, copié par tools/update-core.sh),
// exécuté dans le navigateur par Pyodide, et piloté par py/web_app.py. Les fichiers Python
// sont dans py/sources.js (généré par le même script) : la page s'ouvre aussi en double-
// cliquant sur index.html (file://), où le navigateur interdit de lire les fichiers voisins.

const Calcul = (() => {
  const PY_ROOT = "/home/pyodide/web";

  /**
   * Charge Pyodide et les fichiers Python de la page, puis crée l'application de mesure.
   * notify : appelée quand une lecture réseau fait avancer une mesure (redessiner).
   */
  async function startCalcul(notify) {
    const pyodide = await loadPyodide();
    for (const [path, source] of Object.entries(PY_SOURCES)) {
      const target = `${PY_ROOT}/${path}`;
      pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
      pyodide.FS.writeFile(target, source);
    }
    pyodide.runPython(`import sys\nsys.path.insert(0, "${PY_ROOT}")`);
    const webApp = pyodide.pyimport("web_app");
    return webApp.App(notify);
  }

  return { startCalcul };
})();
