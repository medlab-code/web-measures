<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Limites structurelles des mesures

Document de synthèse – novembre 2026

Voici ce qu’on peut faire **structurellement** (changements d’architecture ou de paradigme) pour améliorer significativement la précision, au-delà des simples réglages de seuils.

### 1. Passer d’un modèle « caméra + GPS » à un modèle multi-capteurs

| Action structurelle | Gain attendu | Difficulté |
|---------------------|--------------|------------|
| **Enregistrer systématiquement l’attitude** (roulis + tangage + cap) dans les métadonnées (XMP GPano ou EXIF) | Élimine presque l’erreur d’inclinaison (actuellement 0,5–3°) | Moyenne (matériel + pipeline de prise de vue) |
| **GNSS RTK/PPK + centrale inertielle** de série | Position ±2–5 cm au lieu de ±10 cm à plusieurs mètres | Élevée (coût matériel) |
| **Synchronisation horloge caméra / GNSS** au ms près | Supprime le décalage temporel (14 cm à 50 km/h pour 10 ms) | Faible à moyenne |

C’est le levier le plus puissant : la plupart des erreurs actuelles viennent de l’absence de ces données.

### 2. Changer la géométrie de reconstruction

| Action | Principe | Gain |
|--------|----------|------|
| **Ajustement en bloc (bundle adjustment)** sur un tronçon entier | Optimiser simultanément positions, orientations et points 3D à partir de points homologues automatiques | Réduit fortement les erreurs systématiques (dérive GPS, décalage de cap) |
| **Structure from Motion (SfM)** contrainte par le GPS | Utiliser des centaines de points homologues au lieu de 2–3 visées manuelles | Précision relative centimétrique sur 50–100 m |
| **Fusion nuage LiDAR + photos** | Projeter les photos sur le nuage LiDAR HD (ou un nuage mobile) plutôt que de trianguler à partir des seules photos | Profondeur et altitude de bien meilleure qualité |

Aujourd’hui on fait de la triangulation « sparse » manuelle. Passer à une reconstruction dense ou semi-dense change d’ordre de grandeur.

### 3. Remplacer les hypothèses géométriques faibles

| Hypothèse actuelle | Remplacement structurel |
|--------------------|-------------------------|
| Sol plat ou MNT basique | Intersection systématique avec le **nuage LiDAR** (ou MNS) plutôt qu’avec un MNT interpolé |
| Plan vertical uniquement | Plans libres définis par 3 points triangulés ou par le nuage |
| Axe de route = BD TOPO ou trajectoire | Axe estimé par **ajustement de la trajectoire RTK** + marquages détectés dans les images |
| Hauteur de caméra unique par séquence | Hauteur estimée photo par photo via le nuage + attitude |

### 4. Architecture de données plus riche

- Stocker pour chaque photo : position + attitude + hauteur de caméra estimée + matrice de covariance.
- Propager les **matrices de covariance complètes** (au lieu de la somme quadratique simplifiée).
- Conserver les **points homologues automatiques** entre photos voisines pour pouvoir relancer un ajustement plus tard.

### 5. Priorisation réaliste

**Gains les plus importants, par ordre d’impact :**

1. **Attitude (roulis/tangage) enregistrée** → gain immédiat et massif sur toutes les mesures au sol.
2. **Bundle adjustment / SfM** sur les séquences → améliore tout le reste (positions, orientations, points).
3. **Intersection systématique avec le nuage LiDAR** plutôt qu’avec le MNT → meilleure profondeur et altitude.
4. **RTK + synchronisation** → position absolue de référence.

Les points 1 et 2 sont les plus « structurels » : ils changent la nature des données d’entrée et le modèle de calcul, pas seulement les paramètres.
