// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Calage manuel de l'inclinaison, côté page : voyant sur le bouton de calage de la visionneuse (nombre de verticales tracées à la main
// sur la photo, vert si elles s'accordent, orange si l'une est douteuse ou aberrante), panneau sous lui (inclinaison retenue, verdict
// de chaque verticale, retrait d'une verticale, « Écarter les aberrantes », « Purger la photo ») et « Purger tout » des réglages.
// Le jugement des verticales est calculé par le cœur (py/core/calibration.py, vertical_report) ; ici, seulement l'affichage.
// Sorti de la page (app.js) : Calage.init s'exécute à la même place ; la page lui rend la main à chaque rafraîchissement par
// l'événement « calage-maj » (sur document).

const Calage = {
  /** Branche le voyant, le panneau et la purge sur la page ; host : etat (état partagé) et fonctions de la page. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const { etat, refresh, showOverViewer } = host;
    const voyant = $("#calage-voyant"), panneau = $("#calage-panneau"), corps = panneau.querySelector("tbody");
    const nombre = (value, digits = 1) => value.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const signe = (value, digits = 1) => (value > 0 ? "+" : "") + nombre(value, digits);
    const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
    let data = null, key = null, hover = null, selected = null;

    const isOpen = () => !panneau.hidden;
    const redraw = () => {  // verticales de la photo numérotées, surbrillance de la choisie ou de la survolée
      if (etat.app && etat.photo) host.drawViewerMarks(JSON.parse(etat.app.viewer_marks()));
    };
    const tell = () => { if (etat.app) etat.app.calage_panel(isOpen(), selected ?? -1, hover ?? -1); };

    /** Panneau sous le bouton de calage, sans sortir de la vue (la page est zoomée par --echelle-ui, comme le panneau). */
    function place() {
      if (!isOpen()) return;
      const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--echelle-ui")) || 1;
      const vue = $("#vue").getBoundingClientRect(), bar = $("#reglage-image").getBoundingClientRect();
      const anchor = (voyant.hidden ? $("#calage-visionneuse") : voyant).getBoundingClientRect();
      const width = panneau.getBoundingClientRect().width;
      const left = Math.max(8, Math.min(anchor.left - vue.left, vue.width - width - 8));
      panneau.style.left = `${left / zoom}px`;
      panneau.style.top = `${(bar.bottom - vue.top + 6) / zoom}px`;
      panneau.style.maxHeight = `${Math.max(120, vue.bottom - bar.bottom - 24) / zoom}px`;
    }

    function showVoyant() {
      const bad = data && (data.outliers.length || data.doubtful.length);
      voyant.hidden = !data;
      voyant.classList.toggle("douteux", Boolean(bad));
      if (!data) return;
      voyant.textContent = String(data.count);
      voyant.title = `Calage manuel : ${plural(data.count, "verticale")}, `
        + (data.outliers.length ? `dont ${plural(data.outliers.length, "aberrante")}` : data.doubtful.length ? "dont une douteuse" : "cohérentes")
        + " (cliquer pour le détail)";
      voyant.setAttribute("aria-label", voyant.title);
    }

    function render() {
      voyant.setAttribute("aria-expanded", String(isOpen()));
      if (!isOpen()) return;
      $("#calage-titre").textContent = data ? `Calage manuel : ${plural(data.count, "verticale")}` : "Calage manuel : aucune verticale";
      const rows = data?.rows ?? [];
      corps.replaceChildren(...rows.map((r, i) => {
        const tr = document.createElement("tr");
        tr.dataset.index = String(i);
        tr.classList.toggle("choisie", selected === i);
        const cells = [String(i + 1), `${signe(r.angle, 2)}°`, r.deviation === null ? "—" : `${nombre(r.deviation, 2)}°`,
          r.effect === null ? "—" : `${nombre(r.effect, 2)}°`, r.verdict ?? "non jugée"];
        cells.forEach((text, c) => {
          const td = Object.assign(document.createElement("td"), { textContent: text });
          if (c === 4 && r.verdict) td.className = r.verdict;
          tr.append(td);
        });
        const del = Object.assign(document.createElement("button"), { type: "button", textContent: "🗑",
          title: `Retirer la verticale ${i + 1}`, ariaLabel: `Retirer la verticale ${i + 1}` });
        del.dataset.retirer = String(i);
        const last = document.createElement("td");
        last.append(del);
        tr.append(last);
        return tr;
      }));
      panneau.querySelector("table").hidden = !data;
      let line = "";
      if (data) {
        const sigma = `±${nombre(Math.max(data.sigma, 0.1))}°`;
        line = data.partial ? `inclinaison partielle : ${nombre(data.tilt, 2)}° vers le cap ${nombre(data.toward, 0)}° (un seul sens corrigé : tracez une verticale à environ 90° de la première)`
          : `inclinaison retenue : roulis ${signe(data.roll)}° ${sigma}, tangage ${signe(data.pitch)}° ${sigma}`;
      }
      $("#calage-retenue").textContent = line;
      let note = "";
      if (data && data.count < 3) note = "Le jugement des verticales commence à 3 (aberrante à partir de 4).";
      else if (data && data.scale === null) note = "À 3 verticales, la plus éloignée seule peut être douteuse : 4 au moins pour en juger une aberrante.";
      else if (data) note = `Écart au consensus des autres verticales : douteuse au-delà de ${nombre(2 * data.scale)}°, aberrante au-delà de ${nombre(3 * data.scale)}°.`;
      $("#calage-note").textContent = note;
      $("#calage-ecarter").disabled = !data?.outliers.length;
      $("#calage-purger").disabled = !data;
      place();
    }

    function open(on) {
      panneau.hidden = !on;
      if (!on) { selected = hover = null; }
      tell();
      render();
      redraw();
    }

    // Recalcul à chaque rafraîchissement de la page, mais seulement si la photo ou le calage a changé
    document.addEventListener("calage-maj", () => {
      if (!etat.app) return;
      const now = `${etat.photo?.id}|${etat.app.calibration_version}`;
      if (now === key) return;
      key = now;
      data = JSON.parse(etat.app.calage_manuel());
      selected = hover = null;
      showVoyant();
      if (!data && isOpen()) { open(false); return; }  // plus de verticale : la pastille disparaît, le panneau se ferme
      if (isOpen()) tell();
      render();
      if (isOpen()) redraw();
    });

    voyant.addEventListener("click", () => open(!isOpen()));
    $("#calage-fermer").addEventListener("click", () => { open(false); voyant.focus(); });
    panneau.addEventListener("keydown", (event) => { if (event.key === "Escape") { open(false); voyant.focus(); } });
    new ResizeObserver(place).observe($("#vue"));

    // Une ligne : survol = surbrillance de la verticale sur la photo ; clic = choisie ; 🗑 = retirée
    const rowOf = (event) => event.target.closest?.("tbody tr");
    corps.addEventListener("mouseover", (event) => {
      const tr = rowOf(event), i = tr ? Number(tr.dataset.index) : null;
      if (i === hover) return;
      hover = i;
      tell();
      redraw();
    });
    corps.addEventListener("mouseleave", () => { hover = null; tell(); redraw(); });
    corps.addEventListener("click", (event) => {
      const remove = event.target.closest?.("button[data-retirer]");
      if (remove) { refresh(etat.app.calage_remove(Number(remove.dataset.retirer))); return; }
      const tr = rowOf(event);
      if (!tr) return;
      selected = selected === Number(tr.dataset.index) ? null : Number(tr.dataset.index);
      tell();
      render();
      redraw();
    });
    $("#calage-ecarter").addEventListener("click", () => refresh(etat.app.calage_drop_outliers()));
    $("#calage-purger").addEventListener("click", () => refresh(etat.app.calage_purge_photo()));

    // Clic sur le trait d'une verticale dans la photo (panneau ouvert, hors mesure) : la ligne correspondante est choisie
    etat.calagePick = (click) => {
      if (!isOpen() || !data || etat.measuring || !etat.app || click.rightclick) return false;
      const index = etat.app.calage_pick(click.yaw, click.pitch);
      if (index < 0) return false;
      selected = index;
      tell();
      render();
      redraw();
      corps.children[index]?.scrollIntoView({ block: "nearest" });
      return true;
    };

    // « Purger tout » (réglages) : toutes les photos, après confirmation
    $("#calage-purger-tout").addEventListener("click", () => {
      const dialog = $("#purger-calage"), c = JSON.parse(etat.app.calibration_json());
      const n = Object.values(c.verticals || {}).reduce((sum, v) => sum + v.length, 0);
      dialog.querySelector("p span").textContent = plural(n, "verticale");
      dialog.returnValue = "";
      dialog.addEventListener("close", () => {
        if (dialog.returnValue === "purger") refresh(etat.app.calage_purge_all());
      }, { once: true });
      showOverViewer(dialog);
    });
  },
};
