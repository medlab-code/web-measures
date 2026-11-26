// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Animation d'attente au centre de la zone concernée (ticket #56, modèle « icône qui émet ») : une pastille sombre avec l'icône de
// l'action en jaune, deux ondes qui s'étendent et s'effacent, une étiquette avec un court message et, dessous, l'étape en cours.
// À la fin, une coche verte (succès) ou une croix rouge et un message court (échec, 6 s), puis fondu.
//
//   const a = Attente.start(zone, { icone: Attente.icones.regle, message: "Chargement du calcul…" });
//   a.etape("photos voisines");      // sous-ligne, « … » ajouté ; texte libre sinon (« 40 % »)
//   a.ok();  a.ok("Vue du dessus prête");   // coche tracée, puis fondu (message facultatif)
//   a.echec("Bird Eye impossible : terrain injoignable");   // croix et message, 6 s
//   a.fin();                         // disparition sans coche (annulation)
//
// Règles : rien n'est affiché si l'action finit en moins de 300 ms (ni coche, ni croix) ; fondus de 200 ms ; l'animation ne
// reçoit jamais le pointeur ; une seule animation visible par zone : la plus récente, celle encore en cours dessous réapparaît
// quand elle finit. Les éléments sont créés dans le document de la zone (carte détachée dans une autre fenêtre : les règles de
// src/attente.css y sont copiées avec les autres feuilles ; la fenêtre de la fiche PDF la charge elle-même). Mouvement réduit : voir attente.css.

const Attente = (() => {
  const DELAI = 300, FONDU = 200, DUREE_COCHE = 800, DUREE_ECHEC = 6000;  // ms
  const SVG = (corps) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${corps}</svg>`;
  /** Icônes (dessin des boutons : viewBox 24, trait 2, extrémités rondes), partagées avec les boutons qui lancent les actions. */
  const icones = {
    regle: SVG('<path d="M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2"/>'),
    niveau: SVG('<rect x="2" y="8" width="20" height="8" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M7 8v8M17 8v8"/>'),
    document: SVG('<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/>'),
    largeur: SVG('<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>'),
    epingle: SVG('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>'),
    de: SVG('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="8.5" cy="8.5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1" fill="currentColor"/>'),
    // Boutons de la carte (resultats.js) : faucon (Bird Eye), appareil photo (capture), fichier « TIF » (export GeoTIFF)
    faucon: SVG('<g transform="rotate(45 12 12) translate(12 12) scale(1.12) translate(-12 -12)"><path fill="currentColor" stroke-width="1" d="M12 4c.6.6 1.3 1.4 1.3 2.2V9c3-1 6-.5 8.7 1.5-3 .3-5.8 1.2-8.7 2.7V16l2 3.5H8.7l2-3.5v-2.8C7.8 11.7 5 10.8 2 10.5 4.7 8.5 7.7 8 10.7 9V6.2c0-.8.7-1.6 1.3-2.2z"/></g>'),
    appareil: SVG('<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>'),
    tif: SVG('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>'
      + '<g stroke-width="1.5"><path d="M7.3 12.5h3.4M9 12.5v5M12.4 12.5v5M14.2 17v-4.5h2.4M14.2 14.7h1.8"/></g>'),
    // Sans bouton dans la page : dessinés dans le même style (borne de PR du requêteur, loupe de la recherche, vidéo du parcours, couches importées)
    pr: SVG('<path d="M7 21V9a5 5 0 0 1 10 0v12M4 21h16M10 10h4M10 14h4"/>'),
    loupe: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
    video: SVG('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3"/>'),
    couches: SVG('<path d="M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5"/>'),
    neutre: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  };
  const COCHE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CROIX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const zones = new WeakMap();  // zone -> attentes pas finies, de la plus ancienne à la plus récente

  /** Une seule attente montrée par zone : la plus récente de celles dont l'élément existe (délai écoulé, ou fin en cours d'affichage). */
  function montrer(zone) {
    const liste = zones.get(zone) || [];
    const visible = [...liste].reverse().find((a) => a.element);
    for (const a of liste) if (a.element) a.element.classList.toggle("on", a === visible);
  }

  function creerElement(zone, a) {
    const doc = zone.ownerDocument;
    const racine = doc.createElement("div");
    racine.className = "attente-zone";
    racine.dataset.etat = "cours";
    // La coche ou la croix remplace l'icône dans la même pastille, à la même place et à la même taille ; les ondes s'arrêtent
    racine.innerHTML = `<div class="col"><span class="ind"><span class="onde"></span><span class="onde"></span><span class="rond"><span class="ic">${a.icone}</span>`
      + `<span class="fin ok">${COCHE}</span><span class="fin ko">${CROIX}</span></span></span>`
      + '<span class="etiq" role="status" aria-live="polite"><span class="txt"></span><span class="sub"></span>'
      + '<span class="msg-ok"></span><span class="msg-echec"></span></span></div>';
    racine.querySelector(".txt").textContent = a.message;
    racine.querySelector(".sub").textContent = a.sousLigne;
    zone.append(racine);
    void racine.offsetWidth;  // état de départ pris en compte : le fondu d'entrée part de là
    return racine;
  }

  /** Retire l'attente : fondu de sortie, puis élément ôté ; celle qui était dessous réapparaît. */
  function retirer(zone, a) {
    clearTimeout(a.delai);
    clearTimeout(a.sortie);
    a.etat = "fini";
    const liste = (zones.get(zone) || []).filter((x) => x !== a);
    zones.set(zone, liste);
    const element = a.element;
    a.element = null;
    if (element) {
      element.classList.remove("on");
      setTimeout(() => element.remove(), FONDU + 50);
    }
    montrer(zone);
  }

  /** Commence une attente au centre de `zone` (élément conteneur, qui doit être positionné). Montrée après 300 ms seulement. */
  function start(zone, { icone = icones.neutre, message = "Calcul en cours…" } = {}) {
    const a = { icone, message, sousLigne: "", etat: "cours", element: null, delai: null, sortie: null };
    zones.set(zone, [...(zones.get(zone) || []), a]);
    a.delai = setTimeout(() => {
      if (a.etat !== "cours") return;
      a.element = creerElement(zone, a);
      montrer(zone);
    }, DELAI);
    /** Termine avec un état affiché `duree` ms (si l'attente a été montrée ; sinon rien du tout). */
    const finir = (etat, duree, texte) => {
      if (a.etat !== "cours") return;
      clearTimeout(a.delai);
      if (!a.element) {
        retirer(zone, a);
        return;
      }
      a.etat = etat;
      a.element.dataset.etat = etat;
      a.element.querySelector(etat === "succes" ? ".msg-ok" : ".msg-echec").textContent = texte || "";
      a.element.classList.toggle("sans-texte", !texte);
      a.sortie = setTimeout(() => retirer(zone, a), duree);
      montrer(zone);  // la plus récente : sa fin passe devant les attentes dessous
    };
    return {
      /** Étape en cours, sous le message (« … » ajouté sauf si le texte finit déjà par une ponctuation ou « % »). */
      etape(texte) {
        a.sousLigne = !texte || /[….%)]$/.test(texte) ? texte || "" : `${texte}…`;
        if (a.element) a.element.querySelector(".sub").textContent = a.sousLigne;
      },
      ok: (texte) => finir("succes", DUREE_COCHE, texte),
      echec: (texte) => finir("echec", DUREE_ECHEC, texte),
      /** Disparition sans coche ni croix (action annulée). */
      fin() {
        if (a.etat === "cours") retirer(zone, a);
      },
    };
  }

  return { start, icones };
})();
