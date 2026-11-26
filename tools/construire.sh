#!/bin/sh
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
# Construction du site sur Cloudflare (Workers Builds, commande « sh tools/construire.sh ») : les fichiers suivis par git
# copiés dans dist/ ; le filigrane de version de la page reçoit la branche (hors main) et la date du dernier commit ;
# les fichiers locaux de la page (src/…) et ceux que src/calcul.js lit (py/…, worker) reçoivent ?v=<commit> (cache).
set -e
cd "$(dirname "$0")/.."
rm -rf dist
mkdir dist
git archive HEAD | tar -x -C dist
branch=${WORKERS_CI_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}
# Filigrane de version : « Version expérimentale X.Y.Z », puis (branche) hors de main, puis date et heure du dernier commit (heure de Paris) ;
# sans git, ni branche ni date. Les numéros de version de main restent ceux des releases (voir CLAUDE.md).
suffixe=
if [ -n "$branch" ] && [ "$branch" != HEAD ] && [ "$branch" != main ]; then suffixe=" ($branch)"; fi
date=$(TZ=Europe/Paris git log -1 --format=%cd --date=format-local:'%d/%m/%Y %H:%M' 2>/dev/null || true)
if [ -n "$date" ]; then suffixe="$suffixe – $date"; fi
if [ -n "$suffixe" ]; then
  sed -i "s|Version expérimentale \([0-9.]*\)</span>|Version expérimentale \1$suffixe</span>|g" dist/index.html
  grep -q "Version expérimentale [0-9.]*$suffixe</span>" dist/index.html  # filigrane introuvable : construction en échec plutôt que muette
fi
# Favicon propre à la branche birdeye (faucon) : index.html garde l'équerre, une fusion dans main ne l'emporte pas
if [ "$branch" = birdeye ]; then
  sed -i 's|href="src/favicon.svg"|href="src/faucon.svg"|' dist/index.html
  grep -q 'href="src/faucon.svg"' dist/index.html  # lien introuvable : construction en échec plutôt que muette
fi
# Version dans l'adresse des fichiers : après une mise en ligne, un visiteur ne mêle pas d'anciens fichiers (cache) aux nouveaux.
# Balise version-fichiers (lue par src/calcul.js pour les .py et le worker) et ?v= sur les <script src="src/…"> et <link href="src/…"> ;
# les adresses des CDN et mobile.html (figée) ne changent pas. Sans git : rien (les fichiers restent sans ?v=).
version=$(git rev-parse --short HEAD 2>/dev/null || true)
if [ -n "$version" ]; then
  sed -i -e "s|<meta name=\"version-fichiers\" content=\"\">|<meta name=\"version-fichiers\" content=\"$version\">|" \
    -e "s|\(<script src=\"src/[^\"?]*\)\"|\1?v=$version\"|g" \
    -e "s|\(<link [^>]*href=\"src/[^\"?]*\)\"|\1?v=$version\"|g" dist/index.html
  grep -q "content=\"$version\"" dist/index.html  # balise introuvable : construction en échec plutôt que muette
  grep -q "src=\"src/calcul.js?v=$version\"" dist/index.html
fi
