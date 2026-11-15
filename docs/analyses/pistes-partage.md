<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Partage du travail entre collègues : pistes

Liste du 15/11/2026 : P1 écartée, le reste à faire. Point de départ : ce que la page exporte et importe ce jour-là.

Ordre proposé :
1. P3 (auteur), puis P2 (import unique, noms explicites) : courts, ils changent l'usage au quotidien (P1 écartée).
2. P4 si des couches à vérifier se partagent entre collègues, P5 si l'on se passe la main sur des chantiers.
3. P6 (déjà noté dans `docs/GUIDE.md`, « Pour plus tard ») ; P7 en dernier.
À revoir selon la façon de travailler à plusieurs (dossier réseau commun ? collègues sous QGIS ? partage surtout de
mesures ou de couches ?).

## Constat

- **Neuf sorties de fichiers**, chacune avec son bouton : mesures (CSV, GeoJSON), couche (« recalée », enregistrée,
  CSV), favoris, calage, parcours (un seul ou la liste), modèles de champs ; plus captures, fiches PDF et GeoTIFF.
- **Noms génériques** : `mesures.geojson`, `calage-panoramax.json`, `parcours-panoramax.json`… Trois collègues
  envoient trois `mesures.geojson`.
- **Cinq imports distincts** (favoris, calage, parcours, modèles, couche) : il faut savoir lequel va avec quel fichier,
  presque tous en JSON, indiscernables à l'extension.
- **Aucun lien direct** : pour montrer une photo, « 📋 Copier » son identifiant, que le collègue colle dans « Aller à la
  photo » ; la vue (cap, inclinaison, zoom) et la mesure sont perdues. La page ne lit rien dans son adresse.
- **Personne n'est nommé** : ni les mesures, ni le relevé, ni les statuts de vérification ne disent qui les a faits.

## Pistes

**P1. Lien de partage.** *Écartée (15/11/2026, demande de l'auteur) : l'adresse du site est amenée à changer, les
liens envoyés ne marcheraient plus. Variante possible : un lien vers la visionneuse officielle Panoramax (photo et vue,
sans la mesure), indépendant de l'adresse du site, que « Aller à la photo » sait déjà rouvrir.*
- **Principe** : « 🔗 Copier le lien » donne une adresse du site qui rouvre la même photo, tournée et zoomée pareil
  (`…/#photo=…&cap=…&inclin=…&zoom=…`) ; la page lit cette adresse à l'ouverture.
- **Avec une mesure** : le lien porte aussi ses repères (comme `vue_ref` à l'import d'un export de mesures), dessinés
  chez le collègue.
- **Gain** : aucun fichier, se colle dans un courriel ou une messagerie ; le site est déjà en ligne. Aurait servi aussi
  l'export inventaire (P6 : lien vers la photo, à faire vers Panoramax).
- **Attention** : adresse du site `main` ou `dev` selon celui ouvert ; une photo d'une autre instance que celle par
  défaut doit la nommer dans le lien.

**P2. Un seul import qui reconnaît le fichier ; noms explicites à l'export.**
- **Import** : un fichier glissé n'importe où sur la page, ou un seul bouton « Importer », reconnu par son contenu
  (favoris, parcours, calage, modèles, couche, mesures) et rangé au bon endroit, avec un message (« 3 parcours
  ajoutés »). Les boutons actuels peuvent rester.
- **Noms** : type, lieu, date, éventuellement initiales (P3) : `mesures RD974 PR12 2026-11-15.geojson`,
  `calage CD21 2025.json`.

**P3. Nom de l'opérateur.**
- **Principe** : réglage « Votre nom ou vos initiales », gardé dans le navigateur, écrit dans une colonne `auteur` des
  mesures, du relevé et des statuts de vérification (avec la date du statut).
- **Gain** : en rassemblant les fichiers de plusieurs personnes, on sait qui a mesuré ou vérifié quoi.

**P4. Fusionner les vérifications d'une même couche.**
- **Cas** : deux collègues se partagent une couche ancienne (arbres), chacun en vérifie une moitié, puis il faut
  réunir les deux.
- **Principe** : à l'import d'un fichier de la même couche, « Fusionner » à côté de « Remplacer » : objets appariés par
  leur `id`, statuts, commentaires, attributs modifiés et recalages de l'autre fichier repris ; conflits (même objet
  modifié des deux côtés) signalés.
- **Coût** : suite naturelle des pistes A et B de la couche (`pistes-couche-sig.md`), plus lourde.

**P5. Dossier de travail en un seul fichier.**
- **Principe** : « Exporter la séance » réunit la couche et ses réglages, les mesures, le relevé, le calage, les
  parcours et les favoris ; importé par le collègue, il retrouve tout tel quel.
- **Gain** : passer la main sur un chantier ; réponse directe aux exports séparés.

**P6. Export inventaire en CSV.** Noté le 15/11/2026 dans `docs/GUIDE.md` (« Pour plus tard ») : une ligne par
mesure, route, PR + abscisse, type, valeur ± incertitude, date de la photo, lien vers la photo. Profiterait de P1
(lien) et de P3 (auteur).

**P7. GeoPackage pour les collègues sous QGIS.**
- **Principe** : un seul `.gpkg` à plusieurs tables (mesures, relevé, couche) au lieu de plusieurs GeoJSON.
- **Coût** : faisable (sql.js est déjà chargé pour lire les GeoPackage), mais lourd ; déjà dans « Plus lourd, moins
  prioritaire » de `pistes-couche-sig.md`.

## Risque à connaître dès aujourd'hui

Les recalages d'objets sont rangés dans le GeoJSON hors des attributs (membre `recalages` du Feature), que QGIS ignore :
une couche ouverte dans QGIS, modifiée puis enregistrée perd ses recalages sans prévenir (les colonnes `verif` et
`verif_note`, elles, survivent). Parades : le dire dans le guide, ou ranger aussi les recalages dans une colonne texte.
