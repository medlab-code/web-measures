// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// WebP animé du parcours, sans bibliothèque : chaque image est encodée par le navigateur
// (canvas.toBlob en image/webp), puis les images sont assemblées dans un conteneur RIFF animé
// (chunks VP8X, ANIM et un ANMF par image, voir la spécification du conteneur WebP de Google).
// Entre deux vues, un fondu enchaîné de quelques images intermédiaires.

const Hyperlapse = (() => {
  const WIDTH = 1280;  // px : largeur au plus des images de l'animation (celle de la vue si elle est plus étroite)
  const HOLD = 400;  // ms : chaque vue seule
  const FADE_STEPS = 2;  // images intermédiaires du fondu
  const FADE_STEP = 70;  // ms : durée de chacune
  const QUALITY = 0.7;  // qualité WebP (avec perte)
  const MAX_FRAMES = 400;  // vues gardées au plus (environ 8 km à une photo tous les 20 m)

  /** Le navigateur encode-t-il le WebP ? (Safari rend du PNG à la place) */
  function supported() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    return canvas.toDataURL("image/webp").startsWith("data:image/webp");
  }

  const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/webp", QUALITY));

  /** Vue de la visionneuse ramenée à WIDTH px au plus, en WebP de bonne qualité (une image brute prendrait
   * 5 Mo en mémoire). Rendue juste avant : sinon le tampon WebGL est vide. */
  function grab(psv) {
    const r = psv.renderer;
    r.renderer.render(r.scene, r.camera);
    const source = r.renderer.domElement;
    const width = Math.min(WIDTH, source.width);
    const canvas = Object.assign(document.createElement("canvas"),
      { width, height: Math.round(source.height * width / source.width) });
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  }

  /** Chunks d'image d'un WebP fixe (ALPH, VP8, VP8L), après l'en-tête RIFF de 12 octets. Les autres
   * (VP8X, profil ICCP que Chrome ajoute) sont interdits dans une image d'animation. */
  function chunks(bytes) {
    const parts = [];
    for (let at = 12; at + 8 <= bytes.length;) {
      const size = bytes[at + 4] | bytes[at + 5] << 8 | bytes[at + 6] << 16 | bytes[at + 7] << 24;
      const end = at + 8 + size + (size & 1);
      if (["ALPH", "VP8 ", "VP8L"].includes(String.fromCharCode(...bytes.subarray(at, at + 4)))) parts.push(bytes.subarray(at, end));
      at = end;
    }
    return parts;
  }

  const u24 = (v) => [v & 255, v >> 8 & 255, v >> 16 & 255];
  const u32 = (v) => [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24 & 255];
  const chunk = (tag, payload) => {
    const parts = [new TextEncoder().encode(tag), new Uint8Array(u32(payload.length)), payload];
    if (payload.length & 1) parts.push(new Uint8Array(1));
    return parts;
  };
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  /** WebP animé (Blob) des vues [Blob de grab], en boucle, avec fondu enchaîné. */
  async function webp(blobs) {
    let view = await createImageBitmap(blobs[0]);  // deux vues décodées à la fois : mémoire limitée
    const { width, height } = view;
    const canvas = Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d");
    const frames = [];  // [{ data, duration }]
    const add = async (duration) => frames.push({ data: new Uint8Array(await (await toBlob(canvas)).arrayBuffer()), duration });
    for (let i = 0; i < blobs.length; i++) {
      ctx.globalAlpha = 1;
      ctx.drawImage(view, 0, 0, width, height);
      await add(HOLD);
      if (i + 1 === blobs.length) break;
      const next = await createImageBitmap(blobs[i + 1]);
      for (let k = 1; k <= FADE_STEPS; k++) {
        ctx.globalAlpha = 1;
        ctx.drawImage(view, 0, 0, width, height);
        ctx.globalAlpha = k / (FADE_STEPS + 1);
        ctx.drawImage(next, 0, 0, width, height);
        await add(FADE_STEP);
      }
      view.close();
      view = next;
    }
    view.close();
    const body = [new TextEncoder().encode("WEBP")];
    body.push(...chunk("VP8X", new Uint8Array([0x02, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)])));  // animation
    body.push(...chunk("ANIM", new Uint8Array([0, 0, 0, 0, 0, 0])));  // fond noir transparent, boucle sans fin
    for (const { data, duration } of frames) {
      // Position 0, 0 ; taille ; durée ; sans mélange avec l'image précédente (bit 1), sans effacement
      const header = new Uint8Array([0, 0, 0, 0, 0, 0, ...u24(width - 1), ...u24(height - 1), ...u24(duration), 0x02]);
      body.push(...chunk("ANMF", concat([header, ...chunks(data)])));
    }
    const payload = concat(body);
    return new Blob([concat([new TextEncoder().encode("RIFF"), new Uint8Array(u32(payload.length)), payload])],
      { type: "image/webp" });
  }

  return { supported, grab, webp, MAX_FRAMES };
})();
