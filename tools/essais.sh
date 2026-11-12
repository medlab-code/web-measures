#!/bin/bash
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Lance des pages d'essai (tests/*.html) dans Google Chrome sans fenêtre, l'une après l'autre, et donne pour
# chacune sa durée et son bilan.
#
#   tools/essais.sh rapide        # sans réseau, quelques secondes : pendant la mise au point
#   tools/essais.sh birdeye       # vue du dessus : synthèse et 3 photos de référence (environ 1 min 30)
#   tools/essais.sh complet       # toutes les pages automatiques hors vidéo : avant une fusion ou une publication
#                                 (vue du dessus : 3 photos de référence ; les 7 : tools/essais.sh essai-dessus-reference)
#   tools/essais.sh video         # pages de la vidéo (longues) : seulement si l'auteur le demande
#   tools/essais.sh essai-ponts essai-dessus-reference#rapide   # pages choisies (#… : passé à la page)
#
# Cache HTTP de Chrome gardé entre les essais (~/.cache/web-measures-essais) : photos et tuiles ne
# viennent du réseau qu'une fois. Profil gardé lui aussi (~/.cache/web-measures-essais-profil) pour le cache de
# l'application (BD TOPO, altitudes, morceaux de nuage LiDAR : sans lui, l'attente d'1 s par requête LiDAR à chaque
# essai) ; stockage local vidé à chaque page. Premier passage complet : supprimer ce profil. Le serveur d'essai
# sert le code du site sans cache (no-store) : les modifications sont toujours prises.
# Chrome est lancé dans son propre scope limité en mémoire et arrêté seul (jamais celui de l'utilisateur) ; le
# serveur est attendu par son numéro de processus (chercher son nom trouverait aussi la commande qui l'attend).

RAPIDE="essai-dessus essai-profil"
BIRDEYE="essai-dessus essai-dessus-reference#rapide"
COMPLET="$RAPIDE navigateur essai-rtk essai-largeur essai-libre essai-releve inclinaison-terrain
  essai-calage essai-profil-pdf essai-cadastre essai-ponts essai-bords essai-nuage essai-dessus-reference#rapide
  essai-cache"  # en dernier : il vide le cache de l'application
VIDEO="essai-avancement-video essai-video essai-boucle essai-chassagne essai-format-video"
PORT=8766 DELAI=900  # secondes au plus par page
# Vrai processeur graphique (Vulkan) : WebGL environ 1,5 fois plus rapide qu'en logiciel (SwiftShader), mêmes résultats
# sur la vue du dessus (09/11/2026) ; CHROME_OPTIONS= tools/essais.sh … pour le rendu logiciel
CHROME_OPTIONS=${CHROME_OPTIONS-"--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist"}

cd "$(dirname "$0")/.." || exit 1
case "${1:-rapide}" in
  rapide) pages=$RAPIDE ;;
  complet) pages=$COMPLET ;;
  video) pages=$VIDEO ;;
  birdeye) pages=$BIRDEYE ;;
  *) pages="$*" ;;
esac
cache=${XDG_CACHE_HOME:-$HOME/.cache}/web-measures-essais
profil=$cache-profil  # gardé entre les pages et les essais : cache de l'application (Cache API) ; le reste vidé à chaque page
journaux=${TMPDIR:-/tmp}/web-measures-essais
mkdir -p "$cache" "$journaux"
total=0 echecs=0
if [ "${1:-rapide}" = rapide ] || [ "${1:-rapide}" = complet ]; then
  # Statut gardé à part : derrière « | tail -1 », un échec des tests Python passait inaperçu.
  sortie=$(python3 -m unittest discover -s tests 2>&1) || echecs=1
  echo "${sortie##*$'\n'}"
fi

echots() { printf '%-28s %5s s  %s\n' "$1" "$2" "$3"; }
for page in $pages; do
  debut=$(date +%s)
  rm -rf "$profil/Default/Local Storage" "$profil/Default/Session Storage" "$profil/Default/IndexedDB"  # comme un premier passage
  fichier=${page%%#*}; suite=${page#"$fichier"}; nom=${fichier}${suite:+-${suite#\#}}
  timeout "$DELAI" python3 tools/serveur-essai.py "$PORT" > "$journaux/$nom.log" 2>&1 &
  serveur=$!
  sleep 0.5
  ( systemd-run --user --scope --quiet --unit="essai-$nom-$$" -p MemoryMax=6G -p MemorySwapMax=1G \
    setsid google-chrome --headless=new $CHROME_OPTIONS --user-data-dir="$profil" --disk-cache-dir="$cache" --no-first-run \
    --remote-debugging-port=0 --window-size=1400,1000 "http://127.0.0.1:$PORT/tests/$fichier.html$suite" > /dev/null 2>&1 & )
  wait "$serveur"
  fin=$?
  systemctl --user stop "essai-$nom-$$.scope" 2> /dev/null
  duree=$(( $(date +%s) - debut )); total=$(( total + duree ))
  bilan=$(grep -E "^(contrôles|ERREUR)" "$journaux/$nom.log" | tail -1)
  [ $fin = 124 ] && bilan="délai dépassé ($DELAI s)"
  [ -z "$bilan" ] && bilan="sans bilan (voir $journaux/$nom.log)"
  case "$bilan" in contrôles*) ;; *) echecs=$(( echecs + 1 )) ;; esac
  echots "$page" "$duree" "$bilan"
done
echo "total : $total s ; échecs (pages, tests Python) : $echecs (journaux : $journaux)"
[ $echecs = 0 ]
