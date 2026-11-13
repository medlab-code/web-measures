#!/bin/sh
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
# Construction du site sur Cloudflare (Workers Builds, commande « sh tools/construire.sh ») : les fichiers suivis par git
# copiés dans dist/ ; hors de main, la date du dernier commit (heure de Paris) remplace le numéro de version dans le
# bandeau, pour savoir quelle version d'essai est en ligne. main garde son numéro (releases, voir CLAUDE.md).
set -e
cd "$(dirname "$0")/.."
rm -rf dist
mkdir dist
git archive HEAD | tar -x -C dist
branch=${WORKERS_CI_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}
if [ -n "$branch" ] && [ "$branch" != HEAD ] && [ "$branch" != main ]; then
  date=$(TZ=Europe/Paris git log -1 --format=%cd --date=format-local:'%d/%m/%Y %H:%M')
  sed -i "s|Version test [0-9.]*|Version $branch du $date|" dist/index.html
  grep -q "Version $branch du $date" dist/index.html  # bandeau introuvable : construction en échec plutôt que muette
fi
# Favicon propre à la branche birdeye (faucon) : index.html garde l'équerre, une fusion dans main ne l'emporte pas
if [ "$branch" = birdeye ]; then
  sed -i 's|href="src/favicon.svg"|href="src/faucon.svg"|' dist/index.html
  grep -q 'href="src/faucon.svg"' dist/index.html  # lien introuvable : construction en échec plutôt que muette
fi
