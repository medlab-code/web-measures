// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Visionneuse Panoramax de la page : cap et champ de la vue, branchement de chaque nouvelle visionneuse
// (chargement des photos, flèches, clics dans la photo, recalage des objets de la couche).
// Sorti de la page (app.js) : Visionneuse.init s'exécute à la même place qu'avant.

const Visionneuse = {
  /** Branche la visionneuse sur la page ; host : etat (état partagé), fonctions de la page, et noms déclarés plus
   * bas dans la page (lus à chaque appel). Rend ce dont la page se sert ailleurs. */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const {
      etat, map, viewer, nez, askFiche, movingId, endMoving, moveOverlayObject, placeOverlayObject, refresh, remindZoom,
      passesFilter, setPhoto, notice,
    } = host;

    // Visionneuse ----------------------------------------------------------------------------

    /** Cap (degrés) du centre de la vue affichée, ou null. La visionneuse s'oriente sur view:azimuth. */
    function viewHeading() {
      if (!etat.photo) return null;
      const azimuth = etat.photo.properties?.["view:azimuth"];
      if (azimuth == null) return null;
      const yaw = etat.psv ? etat.psv.getPosition().yaw : 0;
      return (yaw * 180 / Math.PI + Number(azimuth) + 360) % 360;
    }

    /** Champs de vision de la vue (degrés) : horizontal (fov) ou vertical. */
    function viewFov(vertical = false) {
      const state = etat.psv?.state || {};
      const value = vertical ? state.vFov : state.hFov;
      if (typeof value === "number" && value > 0) return value;
      return vertical ? 60 : 90;
    }

    /** Cap du cône de la vue sur la carte ; null (croix seule) avec Bird Eye, qui couvrirait la vue du dessus. */
    function coneHeading() { return $("#dessus").checked ? null : viewHeading(); }

    let guideHeading = null;
    function updateCursor() {
      if (etat.photo) Carte.showView(map, etat.photo.geometry.coordinates, coneHeading(), viewFov());
      // Flèches des photos proposées : refaites quand la vue a tourné de plus de 5°
      const heading = viewHeading();
      if (etat.guideShown && heading != null
        && (guideHeading == null || Math.abs(((heading - guideHeading) % 360 + 540) % 360 - 180) > 5)) {
        guideHeading = heading;
        host.showGuide(etat.guideShown);
      }
    }

    /**
     * Largeur : réticule tenu sur la droite de mesure (tirets bleus) sous le pointeur, masqué pendant ce
     * temps, là où le bord se posera : seule la direction du clic compte, le bord est sur cette droite (ticket #18).
     * event null : repère retiré.
     */

    /** Point de la droite de la vue passant par les directions a et c (grand cercle) le plus proche
     * de (yaw, pitch) ; même calcul que web_app._on_axis, qui contraint le clic. */
    function onAxis([a, c], yaw, pitch) {
      const vec = (y, p) => [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
      const [va, vc, v] = [vec(...a), vec(...c), vec(yaw, pitch)];
      const n = [va[1] * vc[2] - va[2] * vc[1], va[2] * vc[0] - va[0] * vc[2], va[0] * vc[1] - va[1] * vc[0]];
      const norm = Math.hypot(...n);
      if (norm < 1e-9) return { yaw, pitch };
      const d = (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / norm;
      const w = v.map((k, i) => k - d * n[i] / norm), length = Math.hypot(...w);
      return { yaw: Math.atan2(w[0], w[2]), pitch: Math.asin(Math.max(-1, Math.min(1, w[1] / length))) };
    }

    /** Croix sélectionnable (App.pick_points : celles du mode en cours) à CROSS_PX pixels au plus du point (x, y) de la
     * visionneuse : un clic là la sélectionne (App.click, on_cross). En pixels, quel que soit le zoom ; le calcul ne
     * connaît que des degrés. */
    const CROSS_PX = 8;  // 99 % des clics à la souris tombent à moins de 4,5 px (mesure à la souris, ticket #43)
    function nearCross(x, y) {
      const view = etat.psv?.getPosition?.();
      if (!view) return false;
      return etat.crossAt.some(([yaw, pitch]) => {
        const cos = Math.sin(pitch) * Math.sin(view.pitch) + Math.cos(pitch) * Math.cos(view.pitch) * Math.cos(yaw - view.yaw);
        if (cos <= 0.05) return false;  // derrière la vue
        const p = etat.psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch });
        return Math.hypot(p.x - x, p.y - y) <= CROSS_PX;
      });
    }

    function slideOnGuide(event) {
      if (!etat.psv) return;
      // Hauteur suivante depuis A : réticule sur l'axe de la première, sauf sur une croix (sélection)
      const box = event && etat.psv.container.getBoundingClientRect();
      const onPhoto = event?.target?.closest?.(".psv-canvas-container, .psv-markers")
        && !event.target.closest(".psv-virtual-tour-link") && !nearCross(event.clientX - box.left, event.clientY - box.top);
      if (event && etat.measuring && $("#mode").value === "height" && etat.heightAxis && onPhoto) {
        const pointer = etat.psv.dataHelper?.viewerCoordsToSphericalCoords?.({ x: event.clientX - box.left, y: event.clientY - box.top });
        if (pointer) {
          const position = onAxis(etat.heightAxis, pointer.yaw, pointer.pitch);
          const [a, c] = etat.heightAxis.map(([yaw, pitch]) => etat.psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch }));
          showSlide(position, "hauteur", Math.atan2(c.y - a.y, c.x - a.x) * 180 / Math.PI + 90);
          return;
        }
      }
      showSlide(null);
    }

    /** Réticule glissant à position (ou retiré si null) ; hauteur : trait jaune en travers de l'axe
     * (angle en degrés à l'écran), environ six fois la largeur du réticule. */
    function showSlide(position, kind, angle = 0) {
      if (position || etat.slideKind) {  // dessiné en WebGL (Traits), comme les mesures ; couleur hors visée et calage
        Traits.attach(etat.psv);
        Traits.setSlide(position && { at: [position.yaw, position.pitch], color: host.reticleColor(etat.tilted, false, false),
          angle: kind === "hauteur" ? angle : null });
      }
      etat.slideKind = position ? kind : null;
      etat.psv.container.classList.toggle("sur-droite", !!position);
    }

    /** Branche les clics, la vue et les changements de photo, une fois la visionneuse prête. */
    function attachViewer() {
      if (etat.psv) return;
      const timer = setInterval(() => {
        if (!viewer.psv) return;
        clearInterval(timer);
        etat.psv = viewer.psv;
        // Flèches de navigation au sol de la visite virtuelle (ellipse violette, triangle blanc) et curseur « aller ici » : masqués pendant les mesures et
        // la largeur dans la visionneuse seulement (classe « sans-fleches » sur le conteneur, posée par applyMeasureUi), visibles sinon.
        // Aucune option de la bibliothèque ne les retire sans couper aussi le lecteur de séquence (« pictures-navigation »
        // = « pic » grise suivant/précédent) : règle CSS dans la racine de la visionneuse ; le calque, recréé à chaque photo, la suit.
        const tourRoot = etat.psv.container.getRootNode();
        if (!tourRoot.getElementById?.("fleches-masquees")) {
          const hide = Object.assign(document.createElement("style"), { id: "fleches-masquees" });
          // Même classe pour le curseur « aller ici » (image ronde violette à triangle, enfant direct du conteneur, sans souris, recréée par
          // le composant) : masqué par règle CSS, donc aussi s'il est créé ou réaffiché après le changement d'outil (largeur ↔ comprise).
          hide.textContent = ".sans-fleches .psv-virtual-tour-arrows { visibility: hidden !important; }\n"
            + ".sans-fleches > img[style*='pointer-events: none'][style*='position: absolute'] { visibility: hidden !important; }";
          (tourRoot === document ? document.head : tourRoot).append(hide);
        }
        // Pendant une mesure, le clic ne va pas à la visionneuse (elle irait à la photo voisine
        // dans la direction cliquée, ou suivrait une flèche) : il devient un point de mesure.
        const dispatch = etat.psv.dispatchEvent;
        etat.psv.dispatchEvent = function (event) {
          // Hors mesure, clic sur un objet de la couche : à recaler ; puis clic : sa nouvelle place
          if (event?.type === "click" && !etat.measuring && etat.overlay && etat.photo) {
            const id = event.data?.target?.closest?.("[data-objet]")?.dataset.objet;
            if (id !== undefined) {  // clic droit : sa fiche PDF ; clic : à recaler
              if (event.data.rightclick) askFiche({ objet: Number(id) });
              else if (movingId() === Number(id)) endMoving();  // déjà choisi : second clic, désélectionné
              else moveOverlayObject(Number(id));
              return true;
            }
            if (movingId() !== null && !event.data?.rightclick) {  // posé : recalage fini, le clic suivant ne le bouge plus
              placeOverlayObject(event.data.yaw, event.data.pitch);
              endMoving();
              return true;
            }
          }
          if (event?.type === "click" && etat.measuring && !host.onArrow(event)) {
            // croix sous le clic, en pixels (voir CROSS_PX) ; sans position dans la vue (clic simulé) : le calcul en juge
            const box = etat.psv.container.getBoundingClientRect(), d = event.data;
            const [x, y] = [d.viewerX ?? d.clientX - box.left, d.viewerY ?? d.clientY - box.top];
            const inside = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= box.width && y <= box.height;
            const onCross = inside ? nearCross(x, y) : undefined;  // undefined : None en Python (null y serait jsnull)
            if (etat.app && event.data?.rightclick) {  // clic droit : sélection d'un point à recaler
              refresh(host.photoReady() ? etat.app.select_point(event.data.yaw, event.data.pitch, onCross) : host.LOADING);
            } else if (etat.app) {
              if (host.photoReady()) remindZoom();
              refresh(host.photoReady() ? etat.app.click(event.data.yaw, event.data.pitch, onCross) : host.LOADING);
            }
            return true;
          }
          return dispatch.call(this, event);
        };
        etat.psv.container.addEventListener("pointermove", slideOnGuide);
        // Appui dans la photo : le bouton ou la liste qui avait le focus le perd (sinon les flèches et Entrée, destinées
        // au point sélectionné, changeraient le mode ou relanceraient le bouton : onNudgeKey les lui laisse)
        etat.psv.container.addEventListener("pointerdown", (event) => {
          const active = document.activeElement;
          if (event.target.closest?.(".psv-canvas-container, .psv-markers") && active?.matches?.("input, select, textarea, button"))
            active.blur();
        });
        etat.psv.container.addEventListener("pointerleave", () => slideOnGuide(null));
        host.attachPlayer();
        etat.psv.addEventListener("position-updated", updateCursor);
        etat.psv.addEventListener("zoom-updated", updateCursor);
        // Écartement des étiquettes : au zoom, et à l'arrêt d'une rotation (pendant, elles
        // tournent ensemble) ; pas à chaque image, qui forcerait une mise en page
        etat.psv.addEventListener("position-updated", () => {
          clearTimeout(etat.declutterTimer);
          etat.declutterTimer = setTimeout(host.scheduleDeclutter, 150);
        });
        etat.psv.addEventListener("zoom-updated", host.scheduleDeclutter);
        etat.psv.addEventListener("picture-loading", host.waitParcelTiles);  // étiquette de parcelle : après la HD
        // Déplacement dans la séquence (flèches de la visionneuse) : nouvelle fiche de photo
        etat.psv.addEventListener("picture-loaded", async (event) => {
          host.applyMeasureUi();  // flèches de la nouvelle photo
          const id = event.detail?.picId;
          if (!id || id === etat.photo?.id) {
            refresh();
            return;
          }
          try {
            const feature = await Carte.photoById(id);  // null : photo d'une autre instance
            if (feature && passesFilter(feature)) {
              setPhoto(feature, true);
            } else if (etat.photo) {  // photo voisine écartée : retour à la précédente
              host.stopPlayer();  // la lecture y reviendrait sans fin
              viewer.select(etat.photo.collection || null, etat.photo.id, true);
              notice(feature ? `Photo voisine hors du filtre (${etat.app ? etat.app.filter_text() : "calcul en chargement"}).`
                : "Photo voisine hors de l'instance choisie.");
            }
          } catch (error) {
            console.error(error);
          }
        });
        host.applyMeasureUi();
        refresh();
        updateCursor();
        nez.update();  // visionneuse prête : bouton « Largeur dans la visionneuse »
      }, 200);
    }

    return {
      slideOnGuide, coneHeading, viewFov, attachViewer, viewHeading,
    };
  },
};
