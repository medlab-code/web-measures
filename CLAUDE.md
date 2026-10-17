# Mesures Panoramax (web-measures) — notes pour Claude Code

Application web de mesure sur les photos Panoramax, pour les utilisateurs sans QGIS.
Reprend les calculs du plugin QGIS « Visionneuse Panoramax »
(`~/claude/visionneuse_panoramax`, dépôt `medlab-code/visionneuse_panoramax`) : voir son
`docs/MESURES.md` (méthodes et validations) et `docs/feuille-de-route.md` (choix de cette
application). Auteur : Cédric COCHART.

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
- Calculs : ne pas réécrire ceux du plugin. Le cœur Python du plugin (sans QGIS) doit
  tourner tel quel dans Pyodide ; ses tests restent la référence.
- Contrôle de syntaxe JavaScript : `gjs` (pas de Node sur le poste).
- Essai dans un vrai navigateur sans fenêtre : Google Chrome du paquet Fedora
  (`google-chrome`, plus de Flatpak), profil temporaire, lancé par `setsid` : à la fin,
  n'arrêter que ce Chrome-là (son groupe de processus, ou les processus portant son profil),
  jamais tous les Chrome par nom (celui de l'utilisateur serait tué).
- Essai de bout en bout : `tools/serveur-essai.py 8766` (s'arrête quand la page écrit « FIN »
  ou « ERREUR »), puis `google-chrome --headless=new --user-data-dir=/tmp/... --no-first-run
  --remote-debugging-port=0 --window-size=1400,1000 http://127.0.0.1:8766/tests/<page>` ;
  le journal s'affiche dans le terminal du serveur (bilan « contrôles : n réussis »).
  Capture de la page d'accueil : `--screenshot=` avec `--virtual-time-budget=8000`.
- `py/core/` est une copie du plugin (`tools/update-core.sh`) : corriger dans le plugin,
  puis recopier. Après toute modification d'un fichier Python sous `py/`, relancer le script :
  il régénère `py/sources.js` (seul chargé par la page).
- Essai en `file://` : l'iframe de
  `tests/navigateur.html` n'y est pas accessible (origines distinctes), essayer sur une
  copie de `index.html` qui embarque le script d'essai.

## Git

- Branche `main`, dépôt privé `medlab-code/web-measures` sur GitHub (privé depuis le 13/10/2026).
