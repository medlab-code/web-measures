#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Serveur local de travail : sert la racine du dépôt sur 127.0.0.1, avec Cache-Control: no-store (modules ES et
# fichiers Python jamais repris du cache). Ne s'arrête pas seul.
#
#   tools/serveur-local.sh start|stop|restart|status|ouvrir [port]
#   tools/serveur-local.sh session-debut|session-fin     # appelés par les hooks de session (JSON sur l'entrée standard)
#
# Port : 8765 par défaut (ou SERVEUR_PORT) ; s'il est pris par un autre processus, le suivant libre, en évitant
# 8766 à 8770 (essais : tools/essais.sh et tools/serveur-essai.py). État dans ~/.cache/web-measures/ : serveur.pid,
# serveur.port, serveur.log, sessions/<session_id> (une par session Claude Code ouverte), hooks.log.
# « stop » n'arrête que le processus lancé par ce script (PID mémorisé, marqueur « serveur-local-http » vérifié
# dans sa ligne de commande).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETAT="${XDG_CACHE_HOME:-$HOME/.cache}/web-measures"
PIDF="$ETAT/serveur.pid"; PORTF="$ETAT/serveur.port"; LOG="$ETAT/serveur.log"
SESSIONS="$ETAT/sessions"; HOOKLOG="$ETAT/hooks.log"
mkdir -p "$ETAT" "$SESSIONS"

vivant() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2> /dev/null \
  && tr '\0' ' ' < "/proc/$(cat "$PIDF")/cmdline" 2> /dev/null | grep -q "serveur-local-http"; }
libre() { ! ss -ltn "sport = :$1" | grep -q LISTEN; }
# Ports réservés aux essais
reserve() { [ "$1" -ge 8766 ] && [ "$1" -le 8770 ]; }

cmd_start() {
  if vivant; then echo "Déjà lancé : http://127.0.0.1:$(cat "$PORTF")/ (PID $(cat "$PIDF"))"; return 0; fi
  local port="${1:-${SERVEUR_PORT:-8765}}" n=0
  while reserve "$port" || ! libre "$port"; do
    port=$((port + 1)); n=$((n + 1))
    [ "$n" -gt 30 ] && { echo "Aucun port libre"; return 1; }
  done
  cd "$REPO"
  # « serveur-local-http » dans la ligne de commande : sert à reconnaître notre processus.
  # 9>&- : le serveur n'hérite pas du verrou des sessions.
  setsid nohup python3 -c '
import http.server, sys  # serveur-local-http
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
        ".tif": "image/tiff", ".py": "text/plain; charset=utf-8", ".json": "application/json"}
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$port" serveur-local-http > "$LOG" 2>&1 < /dev/null 9>&- &
  echo $! > "$PIDF"; echo "$port" > "$PORTF"
  for _ in $(seq 12); do curl -sf -o /dev/null "http://127.0.0.1:$port/index.html" && break; sleep 0.25; done
  if curl -sf -o /dev/null "http://127.0.0.1:$port/index.html"; then
    echo "Serveur prêt : http://127.0.0.1:$port/ (PID $(cat "$PIDF"), journal $LOG)"
  else
    echo "Le serveur ne répond pas, voir $LOG"; tail -5 "$LOG"
    vivant && kill "$(cat "$PIDF")" || true
    rm -f "$PIDF" "$PORTF"; return 1
  fi
}
cmd_stop() {
  if vivant; then kill "$(cat "$PIDF")"; echo "Serveur arrêté (PID $(cat "$PIDF"))."; else echo "Aucun serveur lancé par ce script."; fi
  rm -f "$PIDF" "$PORTF"
}
cmd_status() {
  if vivant; then echo "En marche : http://127.0.0.1:$(cat "$PORTF")/ (PID $(cat "$PIDF"))"; else echo "Arrêté."; fi
}
cmd_ouvrir() { cmd_start "$@"; xdg-open "http://127.0.0.1:$(cat "$PORTF")/" > /dev/null 2>&1 || true; }

# --- Hooks de session : jamais bloquants, toujours code 0, erreurs dans hooks.log ---
journal() { echo "$(date '+%F %T') $*" >> "$HOOKLOG"; }
# Lit le JSON du hook : positionne SID et RAISON (vides si illisibles ou identifiant douteux)
lire_json() {
  local json; json="$(cat)"
  SID="$(printf '%s' "$json" | jq -r '.session_id // empty' 2> /dev/null || true)"
  RAISON="$(printf '%s' "$json" | jq -r '.reason // empty' 2> /dev/null || true)"
  case "$SID" in ''|*[!A-Za-z0-9_-]*) journal "session_id absent ou invalide"; SID="" ;; esac
}
session_debut() {
  lire_json
  [ -n "$SID" ] || return 0
  exec 9> "$ETAT/verrou"; flock -w 3 9 || { journal "verrou non obtenu (début $SID)"; return 0; }
  find "$SESSIONS" -type f -mmin +1440 -delete 2> /dev/null || true   # sessions plantées sans SessionEnd
  : > "$SESSIONS/$SID"
  local sortie
  if sortie="$(cmd_start 2>&1)"; then
    echo "Serveur local : http://127.0.0.1:$(cat "$PORTF")/"
  else
    journal "démarrage en échec : $sortie"
  fi
}
session_fin() {
  lire_json
  [ -n "$SID" ] || return 0
  exec 9> "$ETAT/verrou"; flock -w 1 9 || { journal "verrou non obtenu (fin $SID)"; return 0; }
  [ -f "$SESSIONS/$SID" ] || { journal "fin $SID : session non enregistrée, rien à faire"; return 0; }
  rm -f "$SESSIONS/$SID"
  find "$SESSIONS" -type f -mmin +1440 -delete 2> /dev/null || true
  # Un /clear est suivi d'un SessionStart : ne pas arrêter pour rien
  if [ "$RAISON" != "clear" ] && [ -z "$(find "$SESSIONS" -type f -print -quit)" ]; then
    journal "fin $SID ($RAISON) : plus de session, $(cmd_stop 2>&1)"
  fi
}

case "${1:-status}" in
  start) shift; cmd_start "$@" ;;
  stop) cmd_stop ;;
  restart) shift; cmd_stop; cmd_start "$@" ;;
  status) cmd_status ;;
  ouvrir) shift; cmd_ouvrir "$@" ;;
  session-debut) session_debut || journal "erreur session-debut"; exit 0 ;;
  session-fin) session_fin || journal "erreur session-fin"; exit 0 ;;
  *) echo "Usage : $0 start|stop|restart|status|ouvrir [port] | session-debut|session-fin"; exit 2 ;;
esac
