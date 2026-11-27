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
    let info = null, data = null, key = null, hover = null, selected = null;  // info : calage_manuel ; data : ses verticales à la main

    const isOpen = () => !panneau.hidden;
    // Mode calage actif (bouton équerre enfoncé) : le panneau s'ouvre de lui-même, reste ouvert même vide, et se ferme à la sortie du
    // mode ; sauf s'il avait été ouvert par la pastille (ouvert par le mode : opened = false)
    const calibrating = () => $("#calage-visionneuse").getAttribute("aria-pressed") === "true";
    let byMode = false;
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
      // sous la barre, et sous l'étiquette du pont (#chute) quand elle est là, à gauche comme lui
      const chute = $("#chute"), cb = chute.hidden ? null : chute.getBoundingClientRect();
      const top = Math.max(bar.bottom, cb && cb.width ? cb.bottom : 0);
      panneau.style.top = `${(top - vue.top + 6) / zoom}px`;
      panneau.style.maxHeight = `${Math.max(120, vue.bottom - top - 24) / zoom}px`;
    }

    const auto = () => info?.auto ?? { available: false, off: false, count: null, loose: false };
    const confidence = () => info?.confidence ?? null;
    // la pastille existe : verticales à la main, calcul automatique, ou seulement une inclinaison dont on dit la confiance (« i »)
    const present = () => Boolean(data || auto().available || confidence());

    const SOURCES = { clics: "verticales à la main", verticales: "verticales", "verticales (seuil élargi)": "verticales (seuil élargi)", lidar: "LiDAR",
      "vue du dessus": "route (vue du dessus)", "vue du dessus (réglée à la main)": "route (vue du dessus)" };
    const rollLabel = () => info?.roll_label ?? "roulis par défaut";
    const nom = (source) => (source === "roulis de campagne" ? rollLabel() : (SOURCES[source] ?? source));
    /** Confiance de l'inclinaison retenue : { classe, texte, titre } (états du cœur : confirmee, desaccord, non_verifiable, pont). */
    function confidenceText() {
      const c = confidence();
      if (!c) return null;
      const degres = (v) => `${nombre(Math.abs(v))}°`;
      const pair = c.pair ? `${nom(c.pair[0])} et ${nom(c.pair[1])}` : "";
      const gap = c.d_pitch === null ? "" : `écart de tangage ${degres(c.d_pitch)} (tolérance ${degres(c.limit_pitch)}), de roulis ${degres(c.d_roll)} (tolérance ${degres(c.limit_roll)})`;
      if (c.state === "confirmee") return { classe: c.state, texte: "confirmée", titre: `${pair} s'accordent : ${gap}` };
      if (c.state === "desaccord") {
        return { classe: c.state, texte: `désaccord : tangage ${degres(c.d_pitch)} / roulis ${degres(c.d_roll)} entre ${nom(c.pair[0])} et ${nom(c.pair[1])} (retenue : ${nom(c.retained.source)})`, titre: gap };
      }
      if (c.state === "pont") return { classe: c.state, texte: "pont : inclinaison non vérifiable", titre: "Sur un pont, le LiDAR décrit le sol sous l'ouvrage : il ne confirme pas l'inclinaison" };
      const names = [...new Set(c.available.map(nom))].filter((n) => n !== rollLabel());
      const texte = names.length === 1 ? `une seule source (${names[0]})` : names.length ? `sources de même nature (${names.join(", ")})` : `seulement le ${rollLabel()}`;
      return { classe: c.state, texte: `non vérifiable : ${texte}`, titre: "Aucune source de l'autre famille (image ou terrain) pour confirmer l'inclinaison" };
    }

    /** Pastille : verticales à la main (nombre, verte ou orange) ; sinon calcul automatique (« A », bleue, grisée s'il est écarté). */
    function showVoyant() {
      const bad = data && (data.outliers.length || data.doubtful.length);
      voyant.hidden = !present();
      voyant.classList.toggle("douteux", Boolean(bad));
      voyant.classList.toggle("auto", !data && auto().available);
      voyant.classList.toggle("info", !data && !auto().available);
      voyant.classList.toggle("desaccord", !data && !auto().available && confidence()?.state === "desaccord");
      voyant.classList.toggle("coupe", !data && auto().off);
      if (!present()) return;
      if (data) {
        voyant.textContent = String(data.count);
        voyant.title = `Calage manuel : ${plural(data.count, "verticale")}, `
          + (data.outliers.length ? `dont ${plural(data.outliers.length, "aberrante")}` : data.doubtful.length ? "dont une douteuse" : "cohérentes")
          + " (cliquer pour le détail)";
      } else if (!auto().available) {
        voyant.textContent = "i";
        voyant.title = `Confiance de l'inclinaison : ${confidenceText().texte} (cliquer pour le détail)`;
      } else {
        voyant.textContent = "A";
        voyant.title = auto().off ? "Calcul automatique des verticales ignoré pour cette photo (cliquer pour le rétablir)"
          : `Inclinaison calculée automatiquement par les verticales de la photo${auto().count ? ` (${auto().edges != null ? `${plural(auto().edges, "arête")}, ${plural(auto().segments, "segment")}` : `${plural(auto().count, "verticale")} détectée${auto().count > 1 ? "s" : ""}`})` : ""} (cliquer pour le détail)`;
      }
      voyant.setAttribute("aria-label", voyant.title);
    }

    /** Ligne sur l'inclinaison retenue quand elle ne vient pas des verticales à la main : calcul automatique (seulement leur nombre) ou
     * autre source de l'ordre de Calibration.tilt, dite simplement. */
    function autoLine() {
      const got = info?.retained, a = auto();
      if (!got) return a.off ? "Calcul automatique des verticales ignoré pour cette photo : aucune autre inclinaison disponible." : "";
      const angles = `roulis ${signe(got.roll)}° ±${nombre(Math.max(got.sigma, 0.1))}°, tangage ${signe(got.pitch)}°`;
      const nb = a.count ? plural(a.count, "verticale") + (a.count > 1 ? " détectées" : " détectée") : "verticales détectées";
      const off = a.off ? "Calcul automatique des verticales ignoré pour cette photo. " : "";
      if (got.source === "clics") return a.off ? "Calcul automatique des verticales ignoré pour cette photo." : a.available ? "Verticales à la main : elles remplacent le calcul automatique." : "";
      if (got.source === "verticales" || got.source === "verticales (seuil élargi)") return "";  // dit en tête du panneau (autoText)
      if (got.source.startsWith("clics + ")) return `Verticale à la main complétée par ${got.source.endsWith("verticales") ? `le calcul automatique (${nb})` : got.source.slice(8)}.`;
      const names = { lidar: "LiDAR HD sous la caméra", "terrain web": "pente et dévers du terrain (expérimental)", "roulis de campagne": `${rollLabel()}, ${info?.pitch_label ?? "tangage inconnu"}` };
      const name = got.source.startsWith("vue du dessus") ? got.source : (names[got.source] ?? got.source);
      return `${off}Inclinaison retenue : ${name}, ${got.source === "roulis de campagne" ? `roulis ${signe(got.roll)}°` : angles}.`;
    }

    /** Calcul automatique de la photo (retenu ou non, sauf écarté) : seulement le nombre de verticales, en tête du panneau. */
    function autoText() {
      const a = auto();
      if (!a.available || a.off || a.roll === undefined) return "";
      const riche = a.edges != null && a.sigma_roll != null;  // indicateurs de qualité : absents des anciennes entrées
      const angles = riche ? `roulis ${signe(a.roll)}° ±${nombre(Math.max(a.sigma_roll, 0.1))}°, tangage ${signe(a.pitch)}° ±${nombre(Math.max(a.sigma_pitch, 0.1))}°`
        : `roulis ${signe(a.roll)}° ±${nombre(Math.max(a.sigma, 0.1))}°, tangage ${signe(a.pitch)}°`;
      const kept = info?.retained?.source;
      const used = kept === "verticales" || kept === "verticales (seuil élargi)" || kept?.startsWith("clics + verticales");
      const text = a.loose ? `Inclinaison calculée automatiquement (seuil élargi, verticales moins sûres) : ${angles}.`
        : riche ? `Inclinaison calculée automatiquement : ${plural(a.edges, "arête")} (${plural(a.segments, "segment")}), plus grand secteur sans verticale ${nombre(a.gap, 0)}°, ${angles}.`
        : `Inclinaison calculée automatiquement : ${plural(a.count, "verticale")} ${a.count > 1 ? "détectées" : "détectée"}, ${angles}.`;
      return used || !kept ? text : text + " Non retenue.";
    }

    /** Raison de fragilité du calcul automatique (cœur : autotilt.fit), ou "" : ajoutée au texte en style d'alerte. */
    function fragileText() {
      const a = auto();
      return a.available && !a.off && a.fragile && a.fragile_reason ? ` — fragile : ${a.fragile_reason}` : "";
    }

    function render() {
      voyant.setAttribute("aria-expanded", String(isOpen()));
      if (!isOpen()) return;
      // Calcul automatique fait (et pas écarté) : son information en tête, sous le titre ; écarté, le bloc (« Rétablir ») passe en bas
      const bloc = $("#calage-auto-bloc"), head = autoText(), sure = confidenceText();
      const ligne = $("#calage-confiance");
      ligne.hidden = !sure;
      ligne.className = sure?.classe ?? "";
      ligne.textContent = sure ? `Confiance de l'inclinaison : ${sure.texte}` : "";
      ligne.title = sure?.titre ?? "";
      $("#calage-titre").textContent = head ? "Calage de l'inclinaison" : data ? `Calage manuel : ${plural(data.count, "verticale")}` : "Calage manuel : aucune verticale";
      const zone = $("#calage-auto");
      zone.textContent = head || (auto().off ? "Calcul automatique des verticales ignoré pour cette photo." : "");
      if (head && fragileText()) {
        const alerte = document.createElement("span");
        alerte.className = "fragile";
        alerte.textContent = fragileText();
        zone.append(alerte);
      }
      bloc.hidden = !auto().available;
      if (head) $("#calage-confiance").after(bloc);
      else panneau.querySelector(".boutons").before(bloc);
      const profil = info?.profile;  // profil de campagne de la photo (py/web_profils.py, #70) : une ligne courte à la suite
      $("#calage-source").textContent = [autoLine(), profil ? `Profil : ${profil.label}.` : ""].filter(Boolean).join(" ");
      $("#calage-source").title = profil ? `Méthode : ${profil.method}. Provenance : ${profil.provenance}.` : "";
      $("#calage-source").hidden = !$("#calage-source").textContent;
      const off = $("#calage-auto-off");
      off.textContent = auto().off ? "Rétablir le calcul automatique" : "Réinitialiser";
      off.disabled = !auto().available;
      off.title = auto().off ? "Reprend l'inclinaison calculée automatiquement par les verticales de cette photo"
        : "Ignore l'inclinaison calculée automatiquement pour cette photo : la source suivante prend le relais (rétablissable)";
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
      let line = calibrating() ? "Aucune verticale à la main : cliquez le pied puis le sommet d'un objet vertical dans la photo, puis « Valider l'objet vertical »."
        : "Aucune verticale à la main sur cette photo.";
      if (data) {
        const sigma = `±${nombre(Math.max(data.sigma, 0.1))}°`;
        const lead = head ? `${plural(data.count, "verticale")} à la main : ` : "";
        line = lead + (data.partial ? `inclinaison partielle : ${nombre(data.tilt, 2)}° vers le cap ${nombre(data.toward, 0)}° (un seul sens corrigé : tracez une verticale à environ 90° de la première)`
          : `${info.retained?.source.startsWith("clics") ? "inclinaison retenue" : "inclinaison de ces verticales (non retenue)"} : roulis ${signe(data.roll)}° ${sigma}, tangage ${signe(data.pitch)}° ${sigma}`);
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

    function open(on, auto = false) {
      panneau.hidden = !on;
      byMode = on && auto;
      if (!on) { selected = hover = null; }
      tell();
      render();
      redraw();
    }

    // Recalcul à chaque rafraîchissement de la page, mais seulement si la photo ou le calage a changé
    document.addEventListener("calage-maj", () => {
      if (!etat.app) return;
      const json = etat.app.calage_manuel(), text = `${etat.photo?.id}|${json}`;  // photo ou calage changé (verticales, calcul automatique, source retenue)
      if (text === key) return;
      key = text;
      info = JSON.parse(json);
      data = info.manual;
      selected = hover = null;
      showVoyant();
      // plus rien à montrer hors mode calage : la pastille disparaît, le panneau se ferme (en mode calage, il reste ouvert, vide)
      if (!present() && isOpen() && !calibrating()) { open(false); return; }
      if (isOpen()) tell();
      render();
      if (isOpen()) redraw();
    });

    voyant.addEventListener("click", () => open(!isOpen()));  // ouvert (ou fermé) à la main : ne suit plus le mode calage
    new MutationObserver(() => {
      if (calibrating()) { if (!isOpen()) open(true, true); }
      else if (byMode) open(false);
    }).observe($("#calage-visionneuse"), { attributes: true, attributeFilter: ["aria-pressed"] });
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
    $("#calage-auto-off").addEventListener("click", () => refresh(etat.app.calage_auto_off(!auto().off)));
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

export { Calage };
