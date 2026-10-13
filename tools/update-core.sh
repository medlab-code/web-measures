#!/bin/sh
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copie le cœur de calcul du plugin Visionneuse Panoramax (dossier core/, sans QGIS) dans
# py/core/, et regroupe les fichiers Python que la page charge dans Pyodide dans py/sources.js
# (script ordinaire : la page s'ouvre aussi en file://). À relancer après toute modification
# d'un fichier Python sous py/.
#
#   tools/update-core.sh [dépôt du plugin] [révision]
#
# Par défaut : ../visionneuse_panoramax, branche dev. Le commit copié est noté dans
# py/core/SOURCE : le cœur ne se modifie pas ici, mais dans le plugin. Révision « travail » :
# copie de l'état non commité du plugin, pour les essais (à recopier d'un commit ensuite).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
plugin=${1:-"$here/../visionneuse_panoramax"}
rev=${2:-dev}
rm -rf "$here/py/core"
mkdir -p "$here/py/core"
if [ "$rev" = travail ]; then
  commit="état de travail de $(git -C "$plugin" rev-parse --abbrev-ref HEAD), non commité"
  cp "$plugin"/core/*.py "$here/py/core/"
  printf '%s\n%s\n' "$commit" "$(date -I)" > "$here/py/core/SOURCE"
else
  commit=$(git -C "$plugin" rev-parse --verify "$rev^{commit}")
  git -C "$plugin" archive "$commit" core | tar -x -C "$here/py"
  printf '%s\n%s\n' "$commit" "$(git -C "$plugin" log -1 --format='%cs %s' "$commit")" > "$here/py/core/SOURCE"
fi
cd "$here/py"
python3 - <<'PY'
import json, pathlib
files = sorted(str(p) for p in pathlib.Path(".").rglob("*.py"))
sources = {f: pathlib.Path(f).read_text(encoding="utf-8") for f in files}
pathlib.Path("sources.js").write_text(
    "// Généré par tools/update-core.sh : fichiers Python de py/, chargés dans Pyodide.\n"
    "// Ne pas modifier : modifier les fichiers .py, puis relancer le script.\n"
    "const PY_SOURCES = " + json.dumps(sources, indent=1, ensure_ascii=False) + ";\n", encoding="utf-8")
print("{} fichiers Python".format(len(files)))
PY
echo "Cœur copié depuis $commit"
