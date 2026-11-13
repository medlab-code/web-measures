// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Code commun des pages d'essai (tests/*.html) : journal envoyé au serveur d'essai (tools/serveur-essai.py),
// attentes de condition, contrôles et bilan. Le lanceur (tools/essais.sh) lit la dernière ligne « contrôles : n
// réussis » ou « ERREUR … » ; le serveur s'arrête sur « FIN » ou « ERREUR ».
//   const { log, sleep, until, soon, expect, expectSoon, near, fin } = Essai;
const Essai = (() => {
  // Journal : envoyé au serveur d'essai, et sous la page si elle a un élément #log
  const log = (t) => {
    const pre = document.getElementById("log");
    if (pre) pre.textContent += t + "\n";
    return fetch("/journal", { method: "POST", body: String(t) }).catch(() => {});
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Attente d'une condition (essai toutes les 250 ms) ; délai dépassé : exception ; sinon durée de l'attente (ms)
  async function until(test, ms, what) {
    const t0 = Date.now();
    while (!test()) {
      if (Date.now() - t0 > ms) throw new Error("délai dépassé : " + what);
      await sleep(250);
    }
    return Date.now() - t0;
  }
  // Attente d'une condition sans exception : vrai si elle est remplie avant le délai (contrôle fait ensuite par expect)
  async function soon(test, ms = 5000) {
    for (const t0 = Date.now(); !test() && Date.now() - t0 < ms;) await sleep(100);
    return !!test();
  }
  // Application chargée dans l'iframe (Pyodide prêt, carte chargée)
  const ready = (w, ms = 180000) => until(() => w.mesures?.app && w.mesures.map?.loaded?.(), ms, "Pyodide");
  // Contrôles : échecs journalisés (« ÉCHEC ») et comptés ; Essai.verbose = true : réussites journalisées aussi
  let failures = 0, checks = 0;
  const expect = (what, ok, detail = "") => {
    checks++;
    if (!ok) failures++;
    if (!ok || Essai.verbose) log(`${ok ? "" : "ÉCHEC "}${what}${detail ? " : " + detail : ""}`);
    return ok;
  };
  const near = (what, value, expected, tol) =>
    expect(what, Math.abs(value - expected) <= tol, `${value} au lieu de ${expected.toFixed(3)} (±${tol})`);
  // Contrôle d'un état attendu après une action : condition attendue jusqu'au délai, puis contrôlée ; detail peut être
  // une fonction, lue après l'attente. Un contrôle « rien ne change » garde une attente fixe (sa condition est déjà vraie).
  const expectSoon = async (what, test, detail = "", ms = 5000) =>
    expect(what, await soon(test, ms), typeof detail === "function" ? detail() : detail);
  // Échec hors contrôle (exception, état inattendu) : compté et journalisé
  const fail = (what) => { failures++; return log("ÉCHEC " + what); };
  const metresIn = (text) => Number(((text || "").match(/(\d+,\d+) m\b/) || [])[1]?.replace(",", "."));
  const verdict = () => log(failures ? `ERREUR ${failures} contrôle(s) sur ${checks} en échec` : `contrôles : ${checks} réussis`);
  // Bilan puis fin de la page
  const fin = async () => { await verdict(); await log(failures ? "ERREUR" : "FIN"); };
  return { log, sleep, until, soon, ready, expect, expectSoon, near, fail, metresIn, verdict, fin, verbose: false,
    get failures() { return failures; }, get checks() { return checks; } };
})();
