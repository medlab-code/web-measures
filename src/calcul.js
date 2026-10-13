// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Cœur de calcul du plugin Visionneuse Panoramax (py/core/, copié par tools/update-core.sh),
// exécuté dans le navigateur par Pyodide, et piloté par py/web_app.py.

const PY_ROOT = "/home/pyodide/web";

/**
 * Charge Pyodide et les fichiers Python de la page, puis crée l'application de mesure.
 * notify : appelée quand une lecture réseau fait avancer une mesure (redessiner).
 */
export async function startCalcul(notify) {
  const pyodide = await loadPyodide();
  const files = await (await fetch("py/manifest.json")).json();
  await Promise.all(files.map(async (path) => {
    const response = await fetch(`py/${path}`);
    if (!response.ok) throw new Error(`py/${path} : HTTP ${response.status}`);
    const target = `${PY_ROOT}/${path}`;
    pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
    pyodide.FS.writeFile(target, await response.text());
  }));
  pyodide.runPython(`import sys\nsys.path.insert(0, "${PY_ROOT}")`);
  const webApp = pyodide.pyimport("web_app");
  return webApp.App(notify);
}
