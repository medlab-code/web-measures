// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Disposition de la page, sortie d'app.js : hauteur de la carte (poignée, repli), plein écran de la
// visionneuse, largeur de la colonne de droite (poignée, repli). Réglages mémorisés (store de la page).

const Disposition = {
  /** Met la page en place (tailles mémorisées) et branche poignées et boutons ; host : fonctions de la
   * page (map, store, setStatus, setSwapped, wantSwap). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const { map, store, setStatus, setSwapped, wantSwap } = host;

    // Luminosité et contraste de l'affichage de la photo : curseurs horizontaux (mémorisés), filtre CSS ----

    for (const [nom, variable] of [["luminosite", "--luminosite"], ["contraste", "--contraste"]]) {
      const curseur = $(`#${nom}`), raz = $(`#${nom}-raz`);
      const applique = () => {
        const valeur = Number(curseur.value);
        $("#vue").style.setProperty(variable, String(valeur / 100));
        raz.disabled = valeur === 100;  // grisé tant que rien n'est changé
        store.set(`photo-${nom}`, valeur === 100 ? "" : String(valeur));
      };
      const gardee = Number(store.get(`photo-${nom}`));
      if (gardee >= 50 && gardee <= 150) curseur.value = String(gardee);
      curseur.addEventListener("input", applique);
      raz.addEventListener("click", () => { curseur.value = "100"; applique(); });
      applique();
    }

    // Filigrane de version toujours sous les pastilles de capture, aligné à droite (CSS : #haut-droite-vue en colonne) : il ne chevauche ni
    // la barre d'outils ni les pastilles. Ici, seulement la barre, qui se resserre quand elle toucherait les pastilles. Le calcul n'utilise que
    // des largeurs mesurées (pas la position courante) : pas d'oscillation.
    {
      const haut = $("#haut-droite-vue"), barre = $("#reglage-image"), fil = $("#filigrane-vue"), pastilles = $("#captures-visionneuse");
      const place = () => {
        const h = haut.getBoundingClientRect();
        if (!h.width || !barre.getBoundingClientRect().width) return;  // photo masquée ou carte en grand : rien à placer
        const ecart = 8, largeur = (e) => e.getBoundingClientRect().width;
        // Tout est recalculé à partir des largeurs naturelles (classes retirées, puis remises dans l'ordre) : le résultat ne dépend pas de
        // l'état précédent, donc pas d'oscillation. Trois niveaux quand la barre toucherait les pastilles de capture (fenêtre étroite,
        // grandes étiquettes) : 1) en ligne ; 2) « serree » : curseurs raccourcis ; 3) « deux-lignes » : luminosité et contraste passent
        // sur une seconde ligne, sous les outils, dans la même étiquette
        haut.classList.remove("filigrane-masque");
        barre.classList.remove("serree", "deux-lignes");
        const libre = h.right - largeur(pastilles) - ecart - barre.getBoundingClientRect().left;
        if (largeur(barre) > libre) {
          barre.classList.add("serree");
          if (largeur(barre) > libre) barre.classList.replace("serree", "deux-lignes");
        }
        // Barre sur deux lignes, plus basse que les pastilles : elle peut encore toucher le filigrane placé dessous, qui est alors masqué
        const f = largeur(fil), droiteBarre = barre.getBoundingClientRect().right;
        haut.classList.toggle("filigrane-masque", f > 0 && barre.classList.contains("deux-lignes") && droiteBarre + 8 > h.right - f);
      };
      if (window.ResizeObserver) {
        const obs = new ResizeObserver(place);
        for (const e of [$("#vue"), barre, haut, fil, pastilles]) obs.observe(e);
      }
      window.addEventListener("resize", place);
      place();
    }

    // Hauteur de la carte : poignée à glisser (mémorisée), bouton pour la replier --------------

    const mapBox = $("#carte");
    const grip = $("#poignee-carte");
    const fold = $("#replier-carte");
    const narrow = window.matchMedia("(max-width: 900px)");  // carte au-dessus du panneau, sous la photo
    const heightKey = () => (narrow.matches ? "carte-hauteur-etroit" : "carte-hauteur");

    function setMapHeight(px) {
      if (px == null) mapBox.style.removeProperty("height");  // taille par défaut (CSS)
      else mapBox.style.height = `${Math.round(px)}px`;
      map.resize();
    }

    function setFolded(folded) {
      mapBox.hidden = folded;
      grip.classList.toggle("repliee", folded);
      fold.textContent = folded ? "▾" : "▴";
      fold.title = folded ? "Afficher la carte" : "Masquer la carte";
      fold.setAttribute("aria-expanded", String(!folded));
      store.set("carte-repliee", folded ? "1" : "");
      if (!folded) map.resize();
    }

    const applySavedHeight = () => setMapHeight(Number(store.get(heightKey())) || null);
    applySavedHeight();
    narrow.addEventListener("change", applySavedHeight);  // chaque disposition garde sa hauteur
    setFolded(store.get("carte-repliee") === "1");

    fold.addEventListener("click", () => setFolded(!mapBox.hidden));
    fold.addEventListener("pointerdown", (event) => event.stopPropagation());  // pas de glisser
    grip.addEventListener("dblclick", (event) => {
      if (event.target === fold || mapBox.hidden) return;
      store.set(heightKey(), "");
      setMapHeight(null);
    });
    grip.addEventListener("pointerdown", (event) => {
      if (mapBox.hidden) return;
      event.preventDefault();
      const startY = event.clientY, startHeight = mapBox.getBoundingClientRect().height;
      // Limites : 8rem de carte au moins, 6rem de panneau (ou de colonne) au moins
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const room = mapBox.parentElement.getBoundingClientRect().height - grip.offsetHeight;
      const max = narrow.matches ? window.innerHeight * 0.85 : room - 6 * rem;
      const move = (e) => setMapHeight(Math.min(max, Math.max(8 * rem, startHeight + e.clientY - startY)));
      const end = () => {  // suivi sur toute la fenêtre : le pointeur sort vite de la poignée
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        store.set(heightKey(), String(Math.round(mapBox.getBoundingClientRect().height)));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });

    // Plein écran de la visionneuse (ticket #39) : toute la page, le reste masqué par style.css --------------

    const FULLSCREEN_IDLE = 3000;  // ms : souris immobile, boutons et étiquettes s'effacent
    let idleTimer = null;
    function wakeFullscreen() {
      document.documentElement.classList.remove("souris-immobile");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => document.documentElement.classList.add("souris-immobile"), FULLSCREEN_IDLE);
    }
    $("#plein-ecran").addEventListener("click", () => {
      const change = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      change.catch((error) => setStatus(`Plein écran impossible : ${error.message}`, "echec"));
    });
    document.addEventListener("fullscreenchange", () => {
      const full = Boolean(document.fullscreenElement), button = $("#plein-ecran");
      button.setAttribute("aria-pressed", String(full));
      button.title = full ? "Quitter le plein écran (Échap)" : "Afficher la visionneuse en plein écran";
      clearTimeout(idleTimer);
      window.removeEventListener("pointermove", wakeFullscreen, true);
      if (full) {
        setSwapped(false);  // colonne masquée, carte comprise
        window.addEventListener("pointermove", wakeFullscreen, true);  // capture : la visionneuse garde ses événements
        wakeFullscreen();
      } else {
        map.resize();  // masquée pendant le plein écran
        wantSwap();
      }
      window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
    });

    // Largeur de la colonne de droite (grand écran) : poignée à glisser, mémorisée -------------

    const column = $("aside");
    const columnGrip = $("#poignee-colonne");
    const columnFold = $("#replier-colonne");

    /** Colonne de droite (carte et panneau) masquée ou affichée ; mémorisé. */
    function setColumnFolded(folded) {
      column.hidden = folded;
      columnGrip.classList.toggle("repliee", folded);
      const below = narrow.matches;  // colonne sous la photo : flèches vers le bas et le haut
      columnFold.textContent = folded ? (below ? "▴" : "◂") : (below ? "▾" : "▸");
      columnFold.title = folded ? "Afficher la carte et le panneau" : "Masquer la carte et le panneau";
      columnFold.setAttribute("aria-expanded", String(!folded));
      store.set("colonne-masquee", folded ? "1" : "");
      if (!folded) map.resize();
      window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
    }

    function setColumnWidth(px) {
      if (px == null) column.style.removeProperty("width");  // largeur par défaut (CSS)
      else column.style.width = `${Math.round(px)}px`;
      map.resize();
      window.dispatchEvent(new Event("resize"));  // visionneuse à la nouvelle taille
    }

    if (Number(store.get("colonne-largeur"))) setColumnWidth(Number(store.get("colonne-largeur")));
    setColumnFolded(store.get("colonne-masquee") === "1");
    narrow.addEventListener("change", () => setColumnFolded(column.hidden));  // sens des flèches
    columnFold.addEventListener("click", () => setColumnFolded(!column.hidden));
    columnFold.addEventListener("pointerdown", (event) => event.stopPropagation());  // pas de glisser
    columnGrip.addEventListener("dblclick", (event) => {
      if (event.target === columnFold || column.hidden) return;
      store.set("colonne-largeur", "");
      setColumnWidth(null);
    });
    columnGrip.addEventListener("pointerdown", (event) => {
      if (column.hidden || narrow.matches) return;  // largeur réglable seulement colonne affichée, à droite
      event.preventDefault();
      const startX = event.clientX, startWidth = column.getBoundingClientRect().width;
      // Limites : 20rem de colonne au moins, 25 % de la fenêtre au moins pour la photo
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const max = window.innerWidth * 0.75;
      const move = (e) => setColumnWidth(Math.min(max, Math.max(20 * rem, startWidth - (e.clientX - startX))));
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        store.set("colonne-largeur", String(Math.round(column.getBoundingClientRect().width)));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });


    return { mapBox, grip, fold, setFolded, columnFold, setColumnFolded };
  },
};
