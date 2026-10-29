#!/bin/sh
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Regroupe les fichiers Python que la page charge dans Pyodide (py/, cœur de calcul py/core/
# compris) dans py/sources.js (script ordinaire : la page s'ouvre aussi en file://). À relancer
# après toute modification d'un fichier Python sous py/.
set -eu
cd "$(dirname "$0")/../py"
python3 - <<'PY'
import json, pathlib
files = sorted(str(p) for p in pathlib.Path(".").rglob("*.py"))
sources = {f: pathlib.Path(f).read_text(encoding="utf-8") for f in files}
pathlib.Path("sources.js").write_text(
    "// Généré par tools/sources.sh : fichiers Python de py/, chargés dans Pyodide.\n"
    "// Ne pas modifier : modifier les fichiers .py, puis relancer le script.\n"
    "const PY_SOURCES = " + json.dumps(sources, indent=1, ensure_ascii=False) + ";\n", encoding="utf-8")
print("{} fichiers Python".format(len(files)))
PY
