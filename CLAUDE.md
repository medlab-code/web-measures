# Mesures Panoramax (web-measures) — notes pour Claude Code

Application web de mesure sur les photos Panoramax, pour les utilisateurs sans QGIS.
Les calculs viennent du plugin QGIS « Visionneuse Panoramax » (`~/claude/visionneuse_panoramax`),
qui n'en a plus depuis le 29/10/2026 : ils vivent ici (`py/core/`, `py/web_app.py`). Méthodes et
validations : `docs/MESURES.md` (repris du plugin) et `docs/CALCULS.md`. Auteur : Cédric COCHART.

## Priorité du dépôt

Prochaine priorité : à définir par l'auteur. Simplification des essais (priorité du 10/11/2026) terminée le
13/11/2026 : code commun des pages (`tests/commun.js`), pages de diagnostic retirées, bilan sur chaque page,
attentes de condition (essai complet : environ 7 → 5 min), parcours de mesure de bout en bout en Python.

## Règles

- Français partout : interface, messages, commentaires, documentation, messages de commit.
  Typographie française (« », espace avant `:`, `;`, `?`).
- En-tête SPDX dans chaque fichier (`GPL-2.0-or-later`, © Cédric COCHART).
- Site statique : HTML, CSS, JavaScript, sans étape de compilation. La page doit s'ouvrir
  par double-clic (`file://`) : scripts ordinaires (pas de modules ES, chaque fichier expose
  un objet : `Carte`, `Services`, `Calcul`), pas de `fetch` de fichiers locaux. Bibliothèques
  par CDN (jsDelivr), versions épinglées.
- Services appelés depuis le navigateur : ils doivent renvoyer les en-têtes CORS (la page
  d'accueil les vérifie). OpenTopoData, qui ne les renvoie pas, a été retiré (ticket #1).
- Cœur de calcul (`py/core/`, repris du plugin) : ses tests sont dans `tests/coeur/` (scènes
  synthétiques à réponse connue) ; tout correctif du cœur s'accompagne d'un test qui échoue sur
  l'ancien code.
- Contrôle de syntaxe JavaScript : `gjs` (pas de Node sur le poste).
- Essai dans un vrai navigateur sans fenêtre : Google Chrome du paquet Fedora
  (`google-chrome`, plus de Flatpak), profil temporaire, lancé par `setsid` : à la fin,
  n'arrêter que ce Chrome-là (son groupe de processus, ou les processus portant son profil),
  jamais tous les Chrome par nom (celui de l'utilisateur serait tué).
  Le lancer dans son propre scope limité en mémoire (`systemd-run --user --scope --quiet
  --unit=essai-x -p MemoryMax=6G -p MemorySwapMax=1G setsid google-chrome …`, arrêt par
  `systemctl --user stop essai-x.scope`) : lancé dans le service de la session, un Chrome tué
  par manque de mémoire a fait tomber la session (06/11/2026).
- Essais rapides d'abord : un calcul de `py/web_app.py` se vérifie par `tests/test_calculs.py`
  (`python3 -m unittest discover -s tests`, sans navigateur ni réseau, quelques secondes avec
  `tests/coeur/`) ; y
  ajouter un cas court par correctif. Mesure de bout en bout (clics, points gardés, résultats, export) : classe
  `Parcours` (App pilotée comme par la page, cœur sans hôte, photos synthétiques). Les pages d'essai dans le navigateur (plusieurs minutes,
  réseau) : une page ciblée pendant la mise au point, l'ensemble seulement avant de publier.
  Retirer les essais qui ne servent plus (faisabilité, diagnostic, option sans enjeu).
- Pages d'essai : code commun dans `tests/commun.js` (`Essai` : journal, `until`, `soon`, `expect`, `expectSoon`,
  bilan par `fin()` ou `await verdict()` avant « FIN »). Attendre une condition, pas une durée ; une attente fixe
  seulement pour un contrôle « rien ne change » (sa condition est déjà vraie avant l'action).
- Lanceur des essais : `tools/essais.sh rapide|birdeye|complet|video|<page>[#…]` (durée et bilan par page, cache
  HTTP gardé entre essais, processeur graphique, Chrome arrêté seul). Vue du dessus pendant la mise au point :
  `tools/essais.sh birdeye` (environ 1 min) ; les 7 photos de référence seulement avant une fusion.
- Essai de bout en bout à la main : `tools/serveur-essai.py 8766` (s'arrête quand la page écrit « FIN »
  ou « ERREUR »), puis `google-chrome --headless=new --user-data-dir=/tmp/... --no-first-run
  --remote-debugging-port=0 --window-size=1400,1000 http://127.0.0.1:8766/tests/<page>` ;
  le journal s'affiche dans le terminal du serveur (bilan « contrôles : n réussis »).
  Capture de la page d'accueil : `--screenshot=` avec `--virtual-time-budget=8000`.
- Un bouton ou une liste déroulante est grisé (`disabled`) tant qu'il ne peut pas encore, ou ne
  peut plus, avoir d'effet : rien à exporter, à annuler, à rétablir, à retirer, à effacer… Grisé
  plutôt que masqué. Son état se recalcule à chaque changement qui le concerne.
- Quand la manière de calculer une mesure change (hauteur, largeur, hauteur de chute sur un
  pont, inclinaison…), mettre à jour dans le même changement les commentaires du code qui la
  décrivent (docstrings, constantes, infobulles, messages), sa description dans le `README.md`
  (« Utilisation », « Précision ») et dans `docs/CALCULS.md`.
- Après toute modification d'un fichier Python sous `py/`, relancer `tools/sources.sh` : il
  régénère `py/sources.js` (seul chargé par la page).
- Essai en `file://` : l'iframe de
  `tests/navigateur.html` n'y est pas accessible (origines distinctes), essayer sur une
  copie de `index.html` qui embarque le script d'essai.

## Git

- Branche `main`, dépôt privé `medlab-code/web-measures` sur GitHub (privé depuis le 13/10/2026).
- Release : tag `vX.Y.Z` et release GitHub (`gh release create … --target main`). Mettre à jour
  dans le même commit le numéro affiché sous le titre (`index.html`, mention « Version test
  X.Y.Z ») et la rubrique « Versions » du `README.md`. Le site Cloudflare
  (https://mesures-panoramax-web.medlab-code.workers.dev/) se met à jour à chaque push sur `main`.
  Celui de la branche `dev` (https://web-measures-dev.medlab-code.workers.dev/, second Worker) se met à
  jour à chaque push sur `dev`.
