#!/bin/bash
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Lance des pages d'essai (tests/*.html) dans Google Chrome sans fenêtre, sur VOIES Chrome à la fois (2 par défaut,
# 1 pour la vidéo : calcul lourd ; ESSAIS_VOIES=n pour en choisir), et donne pour chacune sa durée et son bilan.
#
#   tools/essais.sh rapide        # sans réseau, quelques secondes : pendant la mise au point
#   tools/essais.sh birdeye       # vue du dessus : synthèse, 3 photos de référence, 6 passages piétons (environ 3 min 30)
#   tools/essais.sh complet       # toutes les pages automatiques hors vidéo : avant une fusion ou une publication
#                                 (vue du dessus : 3 photos de référence ; les 7 : tools/essais.sh essai-dessus-reference)
#   tools/essais.sh passages      # vue du dessus sur 17 passages piétons de l'auteur (environ 6 min) : avant une
#                                 fusion qui touche l'inclinaison, la hauteur ou l'incertitude de la vue du dessus
#   tools/essais.sh video         # pages de la vidéo (longues) : seulement si l'auteur le demande
#   tools/essais.sh essai-ponts essai-dessus-reference#rapide   # pages choisies (#… : passé à la page)
#
# Chaque voie a son port (PORT, PORT + 1…), son profil et son cache HTTP (deux Chrome sur le même cache HTTP risquent
# de l'abîmer) : voie 1 dans les dossiers ci-dessous, voie n dans …-n.
# Cache HTTP de Chrome gardé entre les essais (~/.cache/web-measures-essais) : photos et tuiles ne
# viennent du réseau qu'une fois. Profil gardé lui aussi (~/.cache/web-measures-essais-profil) pour le cache de
# l'application (BD TOPO, altitudes, morceaux de nuage LiDAR : sans lui, l'attente d'1 s par requête LiDAR à chaque
# essai) ; le reste du profil vidé à chaque page ; essai-cache, qui vide ce cache, sur un profil jetable. Premier passage
# complet : supprimer ce profil. Le serveur d'essai sert le code du site sans cache (no-store) : les modifications
# sont toujours prises.
# Chrome est lancé dans son propre scope limité en mémoire et arrêté seul (jamais celui de l'utilisateur) ; le
# serveur est attendu par son numéro de processus (chercher son nom trouverait aussi la commande qui l'attend).

RAPIDE="essai-dessus essai-profil"
BIRDEYE="essai-dessus essai-dessus-reference#rapide essai-passages#rapide"
# pages longues d'abord : la file des voies finit sur les courtes
COMPLET="essai-dessus-reference#rapide essai-releve navigateur essai-cache essai-largeur essai-rtk essai-bords
  inclinaison-terrain essai-nuage essai-cadastre essai-ponts essai-dessus essai-mobile essai-calage essai-profil-pdf
  essai-profil"
PASSAGES="essai-passages"
VIDEO="essai-avancement-video essai-video essai-boucle essai-chassagne essai-format-video"
PORT=8766 DELAI=900  # secondes au plus par page
# Vrai processeur graphique (Vulkan) : WebGL environ 1,5 fois plus rapide qu'en logiciel (SwiftShader), mêmes résultats
# sur la vue du dessus (09/11/2026) ; CHROME_OPTIONS= tools/essais.sh … pour le rendu logiciel
CHROME_OPTIONS=${CHROME_OPTIONS-"--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist"}

cd "$(dirname "$0")/.." || exit 1
voies=2
case "${1:-rapide}" in
  rapide) pages=$RAPIDE ;;
  complet) pages=$COMPLET ;;
  video) pages=$VIDEO voies=1 ;;
  birdeye) pages=$BIRDEYE ;;
  passages) pages=$PASSAGES ;;
  *) pages="$*" ;;
esac
voies=${ESSAIS_VOIES:-$voies}
base=${XDG_CACHE_HOME:-$HOME/.cache}/web-measures-essais
journaux=${TMPDIR:-/tmp}/web-measures-essais
mkdir -p "$journaux"
total=0 echecs=0
if [ "${1:-rapide}" = rapide ] || [ "${1:-rapide}" = complet ]; then
  # Statut gardé à part : derrière « | tail -1 », un échec des tests Python passait inaperçu.
  sortie=$(python3 -m unittest discover -s tests 2>&1) || echecs=1
  echo "${sortie##*$'\n'}"
fi

echots() { printf '%-28s %5s s  %s\n' "$1" "$2" "$3"; }
# Chrome fermé proprement (Browser.close par son port de débogage), puis son scope arrêté : tué d'un coup (tous ses
# processus à la fois) juste après une page qui écrit beaucoup dans le cache (essai-video), il laissait le stockage
# du profil gardé bloqué au lancement suivant (Cache API, IndexedDB, quotas sans réponse : essai-boucle arrêté après
# « application prête », 16/11/2026).
fermer() {
  local port
  port=$(head -1 "$1/DevToolsActivePort" 2> /dev/null)
  if [ -n "$port" ]; then
    python3 - "$port" << 'EOF' 2> /dev/null
import asyncio, json, sys, urllib.request, websockets
async def close(port):
    url = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=5))["webSocketDebuggerUrl"]
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
        await asyncio.wait_for(ws.recv(), 5)
asyncio.run(close(sys.argv[1]))
EOF
    for _ in $(seq 20); do  # 10 s au plus pour finir d'écrire
      systemctl --user is-active --quiet "$2" || break
      sleep 0.5
    done
  fi
  systemctl --user stop "$2" 2> /dev/null
}
# Une page dans la voie $2 (0, 1…) : écrit « durée|bilan » dans $journaux/<page>.bilan
essai() {
  local page=$1 voie=$2 debut fichier suite nom dossier serveur fin duree bilan
  local port=$(( PORT + voie )) cache=$base profil
  [ "$voie" = 0 ] || cache=$base-$(( voie + 1 ))
  profil=$cache-profil  # gardé entre les pages et les essais : cache de l'application (Cache API) ; le reste vidé
  mkdir -p "$cache"
  debut=$(date +%s)
  # comme un premier passage : tout le profil retiré sauf le cache de l'application (Cache API, sous « Service Worker ») et
  # le registre des quotas, sans lequel Chrome l'abandonne ; en retirer seulement le stockage local laissait des parcours
  # vidéo d'un essai à l'autre (système de fichiers, etc.)
  find "$profil" -mindepth 1 -maxdepth 2 ! -path "$profil/Default" ! -path "$profil/Default/Service Worker" \
    ! -path "$profil/Default/WebStorage" -exec rm -rf {} + 2> /dev/null
  fichier=${page%%#*}; suite=${page#"$fichier"}; nom=${fichier}${suite:+-${suite#\#}}
  dossier=$profil
  [ "$fichier" = essai-cache ] && dossier=$(mktemp -d "$journaux/profil-XXXX")  # il vide le cache : profil jetable
  timeout "$DELAI" python3 tools/serveur-essai.py "$port" > "$journaux/$nom.log" 2>&1 &
  serveur=$!
  sleep 0.5
  ( systemd-run --user --scope --quiet --unit="essai-$nom-$$" -p MemoryMax=6G -p MemorySwapMax=1G \
    setsid google-chrome --headless=new $CHROME_OPTIONS --user-data-dir="$dossier" --disk-cache-dir="$cache" --no-first-run \
    --remote-debugging-port=0 --window-size=1400,1000 "http://127.0.0.1:$port/tests/$fichier.html$suite" > /dev/null 2>&1 & )
  wait "$serveur"
  fin=$?
  fermer "$dossier" "essai-$nom-$$.scope"
  [ "$dossier" = "$profil" ] || rm -rf "$dossier"
  duree=$(( $(date +%s) - debut ))
  bilan=$(grep -E "^(contrôles|ERREUR)" "$journaux/$nom.log" | tail -1)
  [ "$fin" = 124 ] && bilan="délai dépassé ($DELAI s)"
  [ -z "$bilan" ] && bilan="sans bilan (voir $journaux/$nom.log)"
  echots "$page" "$duree" "$bilan"
  echo "$duree|$bilan" > "$journaux/$nom.bilan"
}
# File des pages : chaque voie libre prend la suivante (rang tenu dans un fichier, sous verrou)
# shellcheck disable=SC2206  # découpage voulu : une page par mot de la liste
liste=($pages)
rang=$journaux/.rang
echo 0 > "$rang"
suivante() { ( flock 9; local k; k=$(< "$rang"); echo $(( k + 1 )) > "$rang"; echo "$k" ) 9> "$rang.verrou"; }
depart=$(date +%s)
for (( v = 0; v < voies; v++ )); do
  (
    while k=$(suivante) && [ "$k" -lt ${#liste[@]} ]; do essai "${liste[k]}" "$v"; done
  ) &
done
wait
rm -f "$rang" "$rang.verrou"
for page in "${liste[@]}"; do
  fichier=${page%%#*}; suite=${page#"$fichier"}; nom=${fichier}${suite:+-${suite#\#}}
  IFS='|' read -r duree bilan < "$journaux/$nom.bilan" 2> /dev/null || bilan="sans bilan"
  total=$(( total + ${duree:-0} ))
  case "$bilan" in contrôles*) ;; *) echecs=$(( echecs + 1 )) ;; esac
  rm -f "$journaux/$nom.bilan"
done
echo "total : $(( $(date +%s) - depart )) s ($total s de pages, $voies voie(s)) ; échecs (pages, tests Python) : $echecs" \
  "(journaux : $journaux)"
[ $echecs = 0 ]
