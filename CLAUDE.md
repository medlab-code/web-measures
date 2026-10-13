# Mesures Panoramax (web-measures) — notes pour Claude Code

Application web de mesure sur les photos Panoramax, pour des agents qui n'utilisent pas
QGIS. Reprend les calculs du plugin QGIS « Visionneuse Panoramax »
(`~/claude/visionneuse_panoramax`, dépôt `medlab-code/visionneuse_panoramax`) : voir son
`docs/MESURES.md` (méthodes et validations) et `docs/feuille-de-route.md` (choix de cette
application). Auteur : Cédric COCHART.

## Règles

- Français partout : interface, messages, commentaires, documentation, messages de commit.
  Typographie française (« », espace avant `:`, `;`, `?`).
- En-tête SPDX dans chaque fichier (`GPL-2.0-or-later`, © Cédric COCHART).
- Site statique : HTML, CSS, JavaScript en modules, sans étape de compilation. Bibliothèques
  par CDN (jsDelivr), versions épinglées.
- Services appelés depuis le navigateur : ils doivent renvoyer les en-têtes CORS (la page
  d'accueil les vérifie). OpenTopoData ne les renvoie pas.
- Calculs : ne pas réécrire ceux du plugin. Le cœur Python du plugin (sans QGIS) doit
  tourner tel quel dans Pyodide ; ses tests restent la référence.
- Contrôle de syntaxe JavaScript : `gjs` (pas de Node sur le poste).
- Essai dans un vrai navigateur sans fenêtre : Chrome en Flatpak, profil temporaire :
  `flatpak run com.google.Chrome --headless=new --user-data-dir=/tmp/... --dump-dom URL`
  (ou `--screenshot=` avec `--filesystem=` sur le dossier de sortie).
- Essai de bout en bout : servir le dossier (`python3 -m http.server 8765 --bind 127.0.0.1`),
  puis `--virtual-time-budget=60000 --window-size=1400,1000 --dump-dom
  http://127.0.0.1:8765/tests/navigateur.html` : le journal est dans le `<pre id="log">`.
- `py/core/` est une copie du plugin (`tools/update-core.sh`) : corriger dans le plugin,
  puis recopier. Tout fichier Python ajouté sous `py/` doit figurer dans `py/manifest.json`
  (régénéré par le même script).

## Git

- Branche `main`, dépôt public `medlab-code/web-measures` sur GitHub.
