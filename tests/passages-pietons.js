// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Photos de passages piétons gardées pour les essais de la vue du dessus (bandes de 0,50 m : échelle en travers et
// roulis restant, voir docs/BIRDEYE.md). Choisies par l'auteur le 13/11/2026 ; passage entier dans la vue, à moins de
// 4 m de la caméra. biais : bandes en biais par rapport à la route (sortie de giratoire).
// essai : page tests/essai-passages.html, « rapide » (#rapide : 6 photos, bien mesurées par la route et par les verticales)
// ou « complet » (avec les rapides : 17 photos) ; null : passage non mesurable dans la vue (essai du 13/11/2026).
const PassagesPietons = [
  { id: "d946f2cf-cddc-4476-a414-35aee429c05a", essai: "rapide", note: "ville (photo de référence de essai-dessus-reference)" },
  { id: "cefbd9bd-419b-4093-ab61-374b9b794c50", essai: "complet", note: "" },
  { id: "cfeb327d-def9-4974-81e2-bc4939ab6556", essai: "complet", note: "biais" },
  { id: "6069c68b-e470-42ee-9cb3-d0640aa86568", essai: null, note: "hors essai : 2 bandes entières au plus" },
  { id: "df8c9042-730b-4894-8e4c-a066d8407bcf", essai: "complet", note: "" },
  { id: "1daa9843-e17b-45ca-b0dd-81d067eb1325", essai: "rapide", note: "" },
  { id: "fb1cf6e0-7900-4cab-97b0-f4423a44a7dd", essai: "rapide", note: "" },
  { id: "5d4e047c-fef6-4d97-9919-3cd6bfb52301", essai: "complet", note: "" },
  { id: "6ee56f3a-8d4d-4d49-9ff5-8137a832e147", essai: "complet", note: "" },
  { id: "ebe65684-cdbe-44e6-a914-3006b3956259", essai: null, note: "hors essai : passage coupé par le véhicule" },
  { id: "151a538e-cf26-4f0c-bda0-3b42527c2438", essai: null, note: "hors essai : pas de passage mesurable" },
  { id: "a2d6fdb1-b07c-4215-9e7b-dea653dc7164", essai: "complet", note: "" },
  { id: "3f28e04b-08d2-4f03-8494-ff8cf84bf0e8", essai: null, note: "hors essai : pas de passage mesurable" },
  { id: "be9241d0-4d86-4896-a131-fd2b26612e21", essai: null, note: "hors essai : pas de passage mesurable" },
  { id: "f2a245d0-aeea-4249-ba9c-fad83b442a23", essai: "complet", note: "" },
  { id: "09c2e813-8426-49cf-8029-bc2f3d511f40", essai: "complet", note: "" },
  { id: "d7c0001a-9710-4674-bc31-f3128b8d8666", essai: "rapide", note: "" },
  { id: "eee3248c-525c-4b89-ac92-e036a792181e", essai: "complet", note: "" },
  { id: "f2c6efea-12ea-4223-b796-607574f555e7", essai: null, note: "hors essai : 2 bandes entières au plus" },
  { id: "e9058d37-e0c5-41e9-8af5-4d5ad5e8bf17", essai: null, note: "hors essai : pas de passage mesurable" },
  { id: "73c0aed3-302a-4929-8215-762ca3ad4729", essai: null, note: "hors essai : 2 bandes entières au plus" },
  { id: "7dcdccf9-3c52-4c54-bc5b-de72740a7967", essai: "complet", note: "" },
  { id: "844afd34-8f00-4a15-a68e-d92b049ad937", essai: "rapide", note: "" },
  { id: "3d643189-2c6c-463a-b905-a78c6bf96619", essai: "rapide", note: "" },
  { id: "e2785be7-92a8-4075-af45-e028f0372e3a", essai: "complet", note: "" },
];
