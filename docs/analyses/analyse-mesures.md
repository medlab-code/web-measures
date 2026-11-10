<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Analyse de MESURES.md

**Pertinence, limites et pistes d’amélioration**  
Document de synthèse – novembre 2026

---

## 1. Pertinence globale

Le document est **très pertinent** et de haute qualité technique. Il décrit avec précision le passage d’une logique « une photo + hypothèse de sol » à une logique **points triangulés**, ce qui est le bon choix (moins sensible aux erreurs d’inclinaison, de hauteur de caméra et de terrain).

### Points particulièrement solides

| Aspect | Évaluation |
|--------|------------|
| **Formule de triangulation** (moindres carrés pondérés) | Correcte et classique |
| **Vérification RTK** (constante de hauteur de caméra + critères stricts) | Très bien pensée et pragmatique |
| **Inclinaison automatique** (verticales + rejet d’outliers + fallback LiDAR) | Méthode robuste, validation chiffrée |
| **Recalage sur carte** (plan vertical + nouvelle visée) | Excellent principe (carte = profondeur, photo = précision angulaire) |
| **Propagation d’incertitude** | Raisonnable (somme quadratique des sources indépendantes) |
| **Ordre d’arrivée des données + recalcul** | Crucial et bien traité |
| **Prise de mesure guidée** | Améliore nettement l’ergonomie et la qualité des visées |

Les ordres de grandeur d’erreur sont réalistes et s’appuient sur des essais concrets (Pouilly-en-Auxois, etc.).

---

## 2. Limites principales

### 2.1 Limites structurelles (acceptables)

- **Dépendance au GPS** : sans RTK vérifié, les mesures restent possibles mais signalées comme peu fiables (± plusieurs mètres). C’est correctement géré.
- **Inclinaison** reste la source d’erreur dominante sur une seule photo (même après triangulation).
- **Plan calé vertical uniquement** : ne gère pas les toitures, talus ou rampes.
- **Façade cadastre** : écarts possibles de plusieurs mètres (documenté) ; le contrôle LiDAR MNS est une bonne garde-fou mais pas infaillible (débord de toit).
- **Analyse fine nuage** et **profil Dévers** sont dans l’application web (`CALCULS.md`), pas dans ce document plugin → légère dissociation des deux codebases.

### 2.2 Limites méthodologiques plus discutables

| Point | Limite | Gravité |
|-------|--------|---------|
| **Sol plat par défaut** (quand pas de MNT) | Hypothèse forte, surtout en zone de relief | Moyenne |
| **Axe de route** | BD TOPO parfois simplifiée ; trajectoire véhicule meilleure en courbe | Faible à moyenne |
| **Incertitude** | Somme quadratique simplifiée ; pas de matrice de covariance complète ni de corrélations GPS/cap | Faible |
| **Recalage carte** | Profondeur fixée à ±0,5 m (orthophoto) ; pas d’accrochage automatique aux bâtiments | Moyenne |
| **Triangulation 3D** | Limitée aux croisements < 20° + altitude vérifiée | Acceptable, mais restrictive |
| **Sections historiques** (largeur/longueur sur une photo, façade, etc.) | Conservées « pour mémoire » alors que le code a été retiré | Risque de confusion pour le lecteur |

### 2.3 Points de friction utilisateurs

- Le recalcul automatique (arrivée d’inclinaison / RTK après les clics) peut surprendre (« ma mesure a changé toute seule »).
- La distinction entre « point provisoire » (étiquette grise) et « triangulé » (bordeaux) est bonne, mais la charge cognitive reste élevée.
- Mode dégradé bien signalé, mais encore trop de cas où l’utilisateur doit caler manuellement.

---

## 3. Améliorations possibles (priorisées)

### Court terme (fort impact / effort modéré)

1. **Score de confiance unifié**  
   Afficher un indicateur global (vert / orange / rouge) combinant :
   - qualité RTK,
   - qualité d’inclinaison,
   - angle de croisement,
   - écart des visées,
   - source du sol (LiDAR HD vs RGE ALTI).

2. **Accrochage intelligent sur la carte**  
   Lors du glisser d’un point, proposer automatiquement les arêtes du cadastre / BD TOPO proches (outils d’accrochage QGIS).

3. **Inclinaison lissée le long de la séquence**  
   Déjà suggéré dans le document : combiner les photos voisines pour stabiliser les photos pauvres en verticales.

4. **Meilleure gestion des points provisoires**  
   Permettre de « verrouiller » un point triangulé pour qu’il ne bouge plus au recalcul (sauf demande explicite).

5. **Nettoyage documentaire**  
   Déplacer clairement les sections 4.1, 4.2, façade, etc. dans une annexe « Méthodes historiques (retirées) » pour éviter toute confusion.

### Moyen terme

6. **Plan calé non vertical**  
   Permettre un plan défini par 3 points triangulés (toiture, talus).

7. **Analyse fine nuage intégrée au plugin**  
   Réutiliser la logique déjà présente dans l’application web (intensité, ligne de rive, séparateur).

8. **Propagation d’incertitude plus complète**  
   Matrice de covariance (au moins pour triangulation + inclinaison commune).

9. **Clic assisté**  
   Accrochage sur bords détectés dans l’image (même simple filtre de gradient).

10. **Fusion trajectoire RTK + BD TOPO plus fine** pour l’axe de route (déjà partiellement fait dans `CALCULS.md`).

### Plus long terme / recherche

- Ajustement en bloc (structure from motion) sur un tronçon.
- Lecture des métadonnées d’inclinaison native (`PosePitchDegrees` / `PoseRollDegrees`) quand elles existent.
- Modèle de dérive GPS le long de la séquence.

---

## 4. Synthèse

| Critère | Note | Commentaire |
|---------|------|-------------|
| **Pertinence technique** | Très bonne | Évolution vers les points triangulés bien justifiée |
| **Rigueur des formules** | Excellente | Triangulation, inclinaison, incertitudes correctes |
| **Transparence des limites** | Excellente | Erreurs et ordres de grandeur clairement exposés |
| **Ergonomie / robustesse** | Bonne | Prise guidée + recalcul automatique bien pensés |
| **Cohérence avec CALCULS.md** | Moyenne | Quelques divergences d’implémentation (axe, analyse fine) |
| **Maintenabilité documentaire** | À améliorer | Sections historiques trop présentes |

**Verdict** : document de référence solide et honnête. Les fondations (triangulation, RTK, inclinaison, recalage carte) sont bonnes. Les gains les plus immédiats se situent dans le **score de confiance**, l’**accrochage carte**, le **lissage d’inclinaison** et le **nettoyage des parties historiques**.

---

*Document généré à partir de l’analyse de `MESURES.md`.*
