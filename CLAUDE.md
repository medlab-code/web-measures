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
- Site statique : HTML, CSS, JavaScript, sans étape de compilation. Il n'est servi que par un
  serveur web (Cloudflare, ou `tools/serveur-essai.py` en local), jamais ouvert par double-clic
  (`file://`, ticket #62). Modules ES (`import` / `export { Carte };`), point d'entrée
  `src/app.js` (seule balise `<script type="module">` d'`index.html`), plus d'objet global. `window.modules`
  (posé par `src/app.js`) donne les objets (`Carte`, `Dessus`…) aux pages d'essai (`w.modules.Dessus`) et à la
  console ; une page qui attend la page testée attend aussi `w.modules`. Une page d'essai qui charge des `src/*.js`
  directement les importe dans un `<script type="module">`. Sources Python lues par `fetch`
  (liste `PY_FILES` de `src/calcul.js`, vérifiée par un test : tout fichier ajouté sous `py/` s'y
  ajoute) ; Web Worker de calcul : `src/worker-calcul.js`. Bibliothèques par CDN (jsDelivr),
  versions épinglées.
- Version mobile retirée le 27/11/2026 (#65) ; à recréer peut-être quand le code sera stabilisé.
- Cache : `tools/construire.sh` ajoute `?v=<commit>` au `<script type="module" src="src/app.js">` et aux `<link href="src/…">`
  d'`index.html`, génère l'import map (`./src/x.js` → `./src/x.js?v=<commit>`, pour les `import` entre modules) et remplit la balise `version-fichiers`, que `src/calcul.js` ajoute aux fichiers Python et
  au worker ; en local, pas de `?v=`.
- Services appelés depuis le navigateur : ils doivent renvoyer les en-têtes CORS (la page
  d'accueil les vérifie). OpenTopoData, qui ne les renvoie pas, a été retiré (ticket #1).
- Cœur de calcul (`py/core/`, repris du plugin) : ses tests sont dans `tests/coeur/` (scènes
  synthétiques à réponse connue) ; tout correctif du cœur s'accompagne d'un test qui échoue sur
  l'ancien code.
- Contrôle de syntaxe JavaScript : `gjs`, ou `node --check` (`node --input-type=module --check < fichier` pour `src/`) (Node 22 sur le poste, pour les outils
  seulement : la page n'en dépend pas).
- Outils installés : GDAL (`ogr2ogr`, `gdalinfo`), `pdal` (LiDAR `.laz`), `sqlite3`, Python
  `pyproj`, `shapely`, `rasterio` et `websockets` (pilotage de Chrome par son port de débogage),
  `shellcheck` (scripts de `tools/`), `ruff` (Python), `tidy` (HTML), `entr`, `fd`, `hyperfine`,
  `pdftotext`, `biome` (dans `~/.local`, installé par `npm i -g --prefix ~/.local`), `grammalecte`
  (`~/.local/bin`, archive de grammalecte.net) : `grammalecte -f <fichier> -owe -off apos nbsp unit typo
  esp maj num` (apostrophe droite et espace ordinaire avant `:` du dépôt ; lignes coupées du Markdown
  lues comme des phrases : beaucoup de faux accords, seulement pour relire un texte suspect).
- `biome lint` à la racine : erreurs JavaScript, CSS et HTML de `src/`, `tests/` et `index.html`
  (`biome.json` : règles « correctness » et « suspicious » seulement, sans style ni mise en forme).
  `noUndeclaredVariables` est actif sur `src/` et `tests/` : plus de liste `ignore` ; une
  bibliothèque de CDN (`maplibregl`, `loadPyodide`…) s'ajoute à `javascript.globals`, les globaux des essais
  (`Essai`, `PassagesPietons`) à l'override de `tests/**`.
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
- Lanceur des essais : `tools/essais.sh rapide|birdeye|passages|complet|video|<page>[#…]` (durée et bilan par page, cache
  HTTP gardé entre essais, processeur graphique, Chrome fermé proprement puis arrêté seul). Deux Chrome à la fois (voies :
  port, profil et cache HTTP chacun ; `ESSAIS_VOIES=n`, vidéo sur une seule) : essai complet environ 3 min 15 au lieu de 6
  (16/11/2026 ; plus lent au premier passage d'une voie, caches froids). Vue du dessus pendant la mise au point :
  `tools/essais.sh birdeye` (environ 3 min 30, dont 6 passages piétons) ; les 7 photos de référence et
  `tools/essais.sh passages` (17 passages piétons, environ 6 min) seulement avant une fusion qui touche la vue du dessus.
- Serveur local de travail : `tools/serveur-local.sh start|stop|status|ouvrir` (sans cache, port 8765), lancé et arrêté
  automatiquement par les hooks de session de `.claude/settings.local.json` (personnel, non commité).
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
  décrivent (docstrings, constantes, infobulles, messages), sa description dans `docs/GUIDE.md`
  (« Utilisation », « Précision ») et dans `docs/CALCULS.md`.

## Git

- Branche `main`, dépôt privé `medlab-code/web-measures` sur GitHub (privé depuis le 13/10/2026).
- Release : tag `vX.Y.Z` et release GitHub (`gh release create … --target main`). Mettre à jour
  dans le même commit le numéro du filigrane (`index.html`, mention « Version expérimentale
  X.Y.Z »), la rubrique « Version » du `README.md` (résumé court) et `docs/VERSIONS.md`. Le site Cloudflare
  (https://mesures-panoramax-web.medlab-code.workers.dev/) se met à jour à chaque push sur `main`.
  Celui de la branche `dev` (https://web-measures-dev.medlab-code.workers.dev/, second Worker) se met à
  jour à chaque push sur `dev`.
