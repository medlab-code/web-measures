#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Serveur des essais dans un vrai navigateur : sert le dossier du site et écrit sur la
sortie standard les lignes que la page d'essai envoie (POST /journal), en temps réel. La
page envoie « FIN » à la fin : le serveur s'arrête alors (le navigateur peut être fermé).

    tools/serveur-essai.py [port]   # puis ouvrir http://127.0.0.1:<port>/tests/navigateur.html
"""

import http.server
import os
import sys
import threading


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        if self.path != "/journal":
            self.send_error(404)
            return
        text = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
        print(text, flush=True)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")  # page d'essai ouverte en file://
        self.end_headers()
        if text.strip() == "FIN" or text.startswith("ERREUR"):
            threading.Thread(target=self.server.shutdown).start()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
