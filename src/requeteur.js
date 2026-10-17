// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Requêteur route + PR, sous la recherche de lieux : la route du département affiché sur la
// carte, puis son point de repère (et une distance depuis lui), choisis dans des listes qui se
// réduisent à chaque frappe. Sections et points de repère de la BD TOPO ; côté droit (D, ou U
// pour une section commune aux deux sens) par défaut, le côté gauche seulement à défaut.

const Requeteur = (() => {
  const COMMUNES = "https://geo.api.gouv.fr/communes";
  const MAX_ITEMS = 100;  // suggestions affichées au plus
  const SIDES = { D: 0, U: 1, G: 2 };  // côté préféré d'abord
  const routesByDept = new Map();  // département -> promesse de la liste des routes
  const prsByRoute = new Map();  // « 21 D974 » -> promesse des PR

  const quote = (text) => String(text).replace(/'/g, "''");

  /** Département au point (lon, lat), ou "" (en mer, hors de France). */
  async function department(lon, lat) {
    const response = await fetch(`${COMMUNES}?lat=${lat}&lon=${lon}&fields=codeDepartement&format=json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json())[0] || {}).codeDepartement || "";
  }

  /** Clé de tri naturel d'un numéro de route : D9, D9A, D90, D111L, D974. */
  function routeKey(numero) {
    const m = /^([A-Z]*)(\d*)(.*)$/.exec(numero);
    return [m[1], Number(m[2] || 0), m[3]];
  }
  function compareRoutes(a, b) {
    const x = routeKey(a), y = routeKey(b);
    return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]);
  }

  /** Numéros des routes repérées (sections de PR) du département, triés. */
  function routes(dept) {
    if (!routesByDept.has(dept)) {
      const promise = (async () => {
        const found = new Set();
        const page = 5000;
        for (let start = 0; ; start += page) {
          const list = await Lieu.features("section_de_points_de_repere", {
            filter: `code_insee_du_departement='${quote(dept)}'`, count: page, start,
            properties: "numero_de_route",
          });
          for (const f of list) if (f.properties?.numero_de_route) found.add(f.properties.numero_de_route);
          if (list.length < page) break;
        }
        return [...found].sort(compareRoutes);
      })();
      promise.catch(() => routesByDept.delete(dept));  // à redemander
      routesByDept.set(dept, promise);
    }
    return routesByDept.get(dept);
  }

  /** Points de repère numérotés de la route : [{ n, a, section, coords }], un par numéro (côté
   * droit d'abord), triés par numéro. */
  function milestones(dept, route) {
    const key = `${dept} ${route}`;
    if (!prsByRoute.has(key)) {
      const promise = Lieu.features("point_de_repere", {
        filter: `route='${quote(route)}' AND code_insee_du_departement='${quote(dept)}'`, count: 5000,
      }).then((list) => {
        const best = new Map();
        for (const f of list) {
          const p = f.properties || {};
          if (!/^\d+$/.test(String(p.numero)) || f.geometry?.type !== "Point") continue;
          const pr = { n: Number(p.numero), a: p.abscisse, section: p.identifiant_de_section,
            side: SIDES[p.cote] ?? 3, coords: f.geometry.coordinates };
          const old = best.get(pr.n);
          if (!old || pr.side < old.side) best.set(pr.n, pr);
        }
        return [...best.values()].sort((x, y) => x.n - y.n);
      });
      promise.catch(() => prsByRoute.delete(key));
      prsByRoute.set(key, promise);
    }
    return prsByRoute.get(key);
  }

  /** Point (lon, lat) à l'abscisse curviligne s (m) le long de la ligne [[lon, lat]]. */
  function pointAt(line, s) {
    const k = Math.cos(line[0][1] * Math.PI / 180) * 111320;
    let along = 0;
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1], [x1, y1] = line[i];
      const len = Math.hypot((x1 - x0) * k, (y1 - y0) * 111320);
      if (along + len >= s && len > 0) {
        const t = (s - along) / len;
        return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
      }
      along += len;
    }
    return line[line.length - 1];
  }

  /** Point à `offset` mètres après le PR `pr`, le long de sa section : distance mise à l'échelle
   * des abscisses officielles entre PR successifs (comme Lieu.describe, en sens inverse). */
  async function locate(pr, offset) {
    if (!offset) return pr.coords;
    const id = quote(pr.section);
    const [section] = await Lieu.features("section_de_points_de_repere", { filter: `identifiant_de_section='${id}'`, count: 1 });
    const g = section?.geometry;
    if (!g) return pr.coords;
    const line = g.type === "MultiLineString" ? g.coordinates.flat() : g.coordinates;
    const prs = (await Lieu.features("point_de_repere", { filter: `identifiant_de_section='${id}'`, count: 500 }))
      .filter((f) => /^\d+$/.test(String(f.properties?.numero)) && f.properties.abscisse != null)
      .map((f) => ({ n: Number(f.properties.numero), a: f.properties.abscisse,
        s: Lieu.project(line, ...f.geometry.coordinates).s }))
      .sort((x, y) => x.a - y.a);
    let k = prs.findIndex((p) => p.n === pr.n);
    if (k < 0) return pr.coords;
    // Section tracée dans le sens des PR décroissants : abscisses curvilignes retournées
    const total = Lieu.project(line, ...line[line.length - 1]).s;
    const reversed = prs.length > 1 && prs[prs.length - 1].s < prs[0].s;
    if (reversed) for (const p of prs) p.s = total - p.s;
    let rest = offset;
    while (k + 1 < prs.length && rest >= prs[k + 1].a - prs[k].a) {
      rest -= prs[k + 1].a - prs[k].a;
      k++;
    }
    const scale = (p, q) => (q && q.a > p.a && q.s > p.s ? (q.s - p.s) / (q.a - p.a) : null);
    const factor = scale(prs[k], prs[k + 1]) ?? scale(prs[k - 1] || {}, prs[k]) ?? 1;
    const s = Math.max(0, Math.min(total, prs[k].s + rest * factor));
    return pointAt(line, reversed ? total - s : s);
  }

  /** Champ à suggestions : `items(texte)` donne les choix [{ label, value }] (ou une promesse),
   * `choose(choix)` reçoit celui retenu (clic, Entrée). */
  function combo(input, list, items, choose) {
    let shown = [], active = -1, asked = 0;

    function render() {
      list.replaceChildren(...shown.map((item, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.className = i === active ? "active" : "";
        li.textContent = item.label;
        li.addEventListener("mousedown", (event) => {  // avant la perte du focus
          event.preventDefault();
          pick(i);
        });
        return li;
      }));
      list.hidden = !shown.length;
      list.children[active]?.scrollIntoView({ block: "nearest" });
    }
    function close() {
      list.hidden = true;
      active = -1;
    }
    function pick(i) {
      const item = shown[i];
      if (!item) return;
      close();
      choose(item);
    }
    async function update() {
      const ticket = ++asked;
      const found = await items(input.value);
      if (ticket !== asked) return;  // frappe plus récente
      shown = found;
      active = -1;
      if (document.activeElement === input || input.ownerDocument.activeElement === input) render();
    }

    input.addEventListener("input", () => update().catch((error) => console.warn("Requêteur :", error)));
    input.addEventListener("focus", () => update().catch((error) => console.warn("Requêteur :", error)));
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!shown.length) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        active = (active + step + shown.length) % shown.length;
        render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        // Sans choix au clavier : la saisie exacte si elle est proposée, sinon la première
        const typed = shown.findIndex((item) => item.label === input.value.trim().toUpperCase()
          || String(item.value) === input.value.trim());
        pick(active >= 0 ? active : typed >= 0 ? typed : 0);
      } else if (event.key === "Escape") {
        close();
      }
    });
    return { refresh: update };
  }

  /** Requêteur sous la recherche de lieux ; `found(lon, lat)` est appelé une fois la carte
   * arrivée au point demandé. */
  function attach(map, found) {
    const box = document.createElement("div");
    box.className = "requeteur";
    box.innerHTML = '<div class="champ route"><input placeholder="Route" aria-label="Numéro de route"'
      + ' autocomplete="off" spellcheck="false" title="Numéro de la route : 974 pour la D974"><ul role="listbox" hidden></ul></div>'
      + '<div class="champ pr"><span class="prefixe" aria-hidden="true">PR</span><input placeholder="n°"'
      + ' aria-label="Point de repère" inputmode="numeric"'
      + ' autocomplete="off" disabled><ul role="listbox" hidden></ul></div>'
      + '<label title="Distance depuis le PR, dans le sens des PR croissants">+ <input class="distance" type="text"'
      + ' inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="0"'
      + ' aria-label="Distance depuis le PR (m)"> m</label>';
    map.getContainer().append(box);
    const [routeInput, prInput] = box.querySelectorAll(".champ input");
    const [routeList, prList] = box.querySelectorAll(".champ ul");
    const distanceInput = box.querySelector(".distance");
    distanceInput.addEventListener("input", () => {  // chiffres seulement (champ texte, sans flèches)
      const digits = distanceInput.value.replace(/\D/g, "");
      if (digits !== distanceInput.value) distanceInput.value = digits;
    });
    let dept = "", route = "", pr = null, marker = null, going = 0;

    async function currentDept() {
      const { lng, lat } = map.getCenter();
      dept = (await department(lng, lat).catch(() => "")) || dept;
      return dept;
    }

    /** Saisie de la route en majuscules, « D » ajouté devant un numéro seul (RD974 -> D974). */
    function normalize(text) {
      const t = text.trim().toUpperCase().replace(/\s+/g, "").replace(/^RD/, "D");
      return /^\d/.test(t) ? `D${t}` : t;
    }

    combo(routeInput, routeList, async (text) => {
      const typed = normalize(text);
      if (!typed) return [];
      const d = await currentDept();
      if (!d) return [];
      return (await routes(d)).filter((r) => r.startsWith(typed)).slice(0, MAX_ITEMS)
        .map((r) => ({ label: r, value: r }));
    }, (item) => {
      routeInput.value = item.value;
      if (item.value !== route) {
        route = item.value;
        pr = null;
        prInput.value = "";
      }
      prInput.disabled = false;
      prInput.focus();
    });
    routeInput.addEventListener("input", () => {
      if (normalize(routeInput.value) === route) return;
      route = "";  // autre route en cours de saisie : PR à rechoisir
      pr = null;
      prInput.value = "";
      prInput.disabled = true;
    });

    combo(prInput, prList, async (text) => {
      if (!route || !dept) return [];
      const typed = text.trim();
      return (await milestones(dept, route)).filter((p) => String(p.n).startsWith(typed)).slice(0, MAX_ITEMS)
        .map((p) => ({ label: `PR ${p.n}`, value: p.n, pr: p }));
    }, (item) => {
      prInput.value = String(item.value);
      pr = item.pr;
      go();
    });
    distanceInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") go();
    });
    distanceInput.addEventListener("change", () => { if (pr) go(); });

    async function go() {
      if (!pr) return;
      const offset = Math.max(0, Math.round(Number(distanceInput.value) || 0));
      const ticket = ++going;
      let lonlat = pr.coords;
      try {
        lonlat = await locate(pr, offset);
      } catch (error) {
        console.warn("Requêteur, distance depuis le PR :", error);
      }
      if (ticket !== going) return;  // autre demande entre-temps
      const label = `${route} PR ${pr.n} +${String(offset).padStart(4, "0")}`;
      marker?.remove();
      const element = document.createElement("div");
      element.className = "repere-requete";
      element.title = label;
      marker = new maplibregl.Marker({ element }).setLngLat(lonlat).addTo(map);
      map.flyTo({ center: lonlat, zoom: Math.max(map.getZoom(), 18), speed: 1.6 });
      map.once("moveend", () => { if (ticket === going) found(lonlat[0], lonlat[1]); });
    }

    // Les touches du requêteur ne doivent pas déplacer la carte
    for (const type of ["keydown", "wheel", "dblclick"]) box.addEventListener(type, (e) => e.stopPropagation());
  }

  return { attach };
})();
