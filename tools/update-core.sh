#!/bin/sh
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copie le cœur de calcul du plugin Visionneuse Panoramax (dossier core/, sans QGIS) dans
# py/core/, et écrit la liste des fichiers Python que la page charge dans Pyodide.
#
#   tools/update-core.sh [dépôt du plugin] [révision]
#
# Par défaut : ../visionneuse_panoramax, branche dev. Le commit copié est noté dans
# py/core/SOURCE : le cœur ne se modifie pas ici, mais dans le plugin.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
plugin=${1:-"$here/../visionneuse_panoramax"}
rev=${2:-dev}
commit=$(git -C "$plugin" rev-parse --verify "$rev^{commit}")
rm -rf "$here/py/core"
mkdir -p "$here/py/core"
git -C "$plugin" archive "$commit" core | tar -x -C "$here/py"
printf '%s\n%s\n' "$commit" "$(git -C "$plugin" log -1 --format='%cs %s' "$commit")" > "$here/py/core/SOURCE"
cd "$here/py"
python3 - <<'PY'
import json, pathlib
files = sorted(str(p) for p in pathlib.Path(".").rglob("*.py"))
pathlib.Path("manifest.json").write_text(json.dumps(files, indent=1) + "\n", encoding="utf-8")
print("{} fichiers Python".format(len(files)))
PY
echo "Cœur copié depuis $commit"
