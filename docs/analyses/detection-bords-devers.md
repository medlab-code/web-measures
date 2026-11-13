<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Amélioration de la détection des bords et talus (mode « Dévers »)

Document de synthèse – novembre 2026  
Contexte : vérification et propositions d’évolution des seuils et de la logique de détection décrits dans `CALCULS.md` (§ 8).

---

## 1. Rappel de la méthode actuelle

### 1.1 Bord de chaussée (§ 8.2)

Sur chaque travers, à partir de 1,5 m de l’origine :

- **Rupture de pente** : écart > **8 points** par rapport à la pente de la chaussée sous l’origine, dans le même sens, sur **trois pas de suite**.
- **Marche** : dénivelé ≥ **5 cm** sur 0,5 m, tenu sur 1,5 m.
- Sans rupture → demi-largeur BD TOPO (sinon 3 m).
- Filtrage : bord situé à plus de **3 m** de la médiane des bords du même côté → ramené à la médiane.

### 1.2 Talus et chute (§ 8.4)

- Talus = partie d’une descente (pente lue sur 2 m ≥ **10 %**) dont la pente vaut au moins **1/3** de la plus forte.
- Hauteur minimale du talus : **0,5 m**.
- Arrêt de la lecture de chute : terrain qui remonte de **1 m** au-dessus du bord.
- Affichage d’un côté seulement s’il descend d’au moins 0,5 m.

### 1.3 Séparateur

1. Marches de sens contraires (0,5–10 m, milieu à ≤ 4 m du milieu théorique BD TOPO).
2. Bosse étroite (1–2 points, ≥ 4 cm).
3. Fallback BD TOPO.

---

## 2. Couverture estimée

| Situation                              | Fréquence approx. | Couverture actuelle | Commentaire                                      |
|----------------------------------------|-------------------|---------------------|--------------------------------------------------|
| Bord net (fossé, talus, bordure)       | 55–65 %           | ~95 %               | Très bonne                                       |
| Accotement plain-pied / pente douce    | 20–25 %           | Moyenne             | Fallback BD TOPO                                 |
| Chaussées séparées classiques          | 8–12 %            | 85–90 %             | Bonne                                            |
| Cas difficiles (végétation, mur, formes irrégulières) | 8–12 % | Faible à moyenne    | Limite principale                                |
| Cas extrêmes (giratoires, carrefours complexes) | < 5 %     | Faible              | Hors scope normal                                |

**Estimation globale : 85–92 %** des cas courants correctement traités (proche de 90 % sur réseau départemental/rural).

---

## 3. Propositions d’amélioration des ~10 % restants

### 3.1 Améliorations sur le MNT seul (rapides)

| Problème                          | Proposition                                      | Impact attendu     |
|-----------------------------------|--------------------------------------------------|--------------------|
| Pente douce continue              | Ajouter un critère de **courbure** (point d’inflexion) | +3 à 4 %          |
| Bombement / dévers déjà marqué    | Normaliser l’écart de pente par rapport à une pente locale lissée (fenêtre 3–5 m) | Réduit faux négatifs |
| Outliers                          | Filtrage robuste (médiane + MAD) à la place du simple seuil 3 m | Plus stable        |
| Petits dénivelés (buses…)         | Seuil de marche abaissé à 3–4 cm si confirmation de continuité longitudinale | Récupère petits ouvrages |

### 3.2 Meilleure utilisation du nuage LiDAR (Analyse fine)

Levier le plus puissant pour les cas difficiles :

- Végétation / murs bas → le nuage redonne le vrai sol et la ligne de rive (intensité).
- Séparateur large ou irrégulier → bande non-revêtue + intensité.
- Accotement plain-pied → fin de l’enrobé (chute d’intensité) + ligne blanche de rive.

**Évolution proposée** :
- Déclencher automatiquement une **analyse fine légère** (un travers + ±10 m) dès que le bord MNT est jugé douteux.
- Garder l’analyse fine complète (bouton utilisateur) pour les cas complexes.

### 3.3 Fusion plus intelligente avec BD TOPO et trajectoire

- Accotement plain-pied : pondérer le fallback BD TOPO avec la trajectoire RTK (le bord ne peut pas s’éloigner trop de la zone roulée).
- Séparateur : si écart largeur détectée / largeur BD TOPO > 2–3 m → forcer recalcul avec le nuage.
- Carrefours / giratoires : détecter la zone (changement d’axe fort ou nœud BD TOPO) et désactiver ou basculer en mode suggestion manuelle sur ±15–20 m.

### 3.4 Score de confiance et bascule automatique

Attribuer un score à chaque bord :

| Situation                    | Confiance |
|------------------------------|-----------|
| Rupture nette + 3 pas        | Haute     |
| Marche seule                 | Moyenne   |
| Fallback BD TOPO             | Basse     |
| Fort écart entre les 5 travers | Basse   |

Comportement :
- Haute → affichage normal
- Moyenne / basse → bord en pointillés + message « bord approximatif – lancer Analyse fine »  
  ou déclenchement automatique d’une analyse fine légère.

---

## 4. Ordre de priorité recommandé

### Court terme (facile, fort rapport coût/bénéfice)
1. Critère de courbure / point d’inflexion
2. Score de confiance + bascule automatique vers analyse fine légère
3. Filtrage robuste des bords (médiane + MAD)

### Moyen terme
4. Analyse fine automatique sur les travers douteux
5. Meilleure fusion trajectoire RTK + BD TOPO pour les plain-pied

### Plus lourd (optionnel)
6. Utilisation de l’intensité même en mode MNT (si le service le permet)
7. Modèle léger de machine learning entraîné sur profils annotés

---

## 5. Résultat attendu

Avec les points 1 + 2 + score de confiance :

- Passage estimé de **~90 %** à **95–97 %** de cas correctement traités **ou correctement signalés comme douteux**.
- Les 3–5 % restants (giratoires complexes, zones très végétalisées, ouvrages atypiques) restent du domaine de la correction manuelle ou de l’analyse fine complète — acceptable.

---

## 6. Points déjà solides (à ne pas modifier)

- Seuil de 8 points + 3 pas (bien calé au-dessus du bruit MNT ≈ ±5 cm)
- Marche ≥ 5 cm
- Définition du talus (10 % + 1/3 de la pente max)
- Arrêt de chute à +1 m
- Hauteur minimale de talus 0,5 m
- Valeurs ARP de dévers (2,5 % / 7 %)

Ces seuils sont cohérents avec le bruit du MNT LiDAR HD et avec les limites de conception routière françaises.

---

*Document généré à partir de l’analyse de `CALCULS.md` et des échanges de vérification.*
