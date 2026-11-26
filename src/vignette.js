// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
// Cartouches des captures de la visionneuse (attribution, localisation).

const Vignette = (() => {
  /** Cartouches d'une capture : attribution en bas à droite, localisation en bas à gauche,
   * ou au-dessus de l'attribution si elles ne tiennent pas côte à côte. */
  function cartouches(ctx, canvas, size, caption, place) {
    const margin = size * 0.7;
    const bottom = canvas.height - margin;
    const width = (text, s) => {
      ctx.font = `500 ${s}px Inter, system-ui, sans-serif`;
      return text ? ctx.measureText(text).width + 1.08 * s : 0;
    };
    // Texte plus large que l'image (vue étroite) : réduit pour tenir dans la largeur
    const fit = (text) => Math.min(size, size * (canvas.width - 2 * margin) / Math.max(width(text, size), 1));
    const captionSize = fit(caption), placeSize = fit(place);
    if (caption) cartouche(ctx, caption, canvas.width - margin, bottom, captionSize, "right");
    if (!place) return;
    const side = width(place, placeSize) + width(caption, captionSize) + 3 * margin <= canvas.width;
    cartouche(ctx, place, margin, side ? bottom : bottom - captionSize * 1.72 - margin / 2, placeSize, "left");
  }

  /** Étiquette d'une capture, dans le style de l'étiquette de localisation de la visionneuse
   * (#lieu : fond sombre semi-transparent, angles arrondis, texte blanc Inter moyen détouré),
   * ses dimensions rapportées à la taille du texte (13 px dans la visionneuse). (x, y) : bas
   * de l'étiquette, à gauche, à droite ou au centre selon align. */
  function cartouche(ctx, text, x, y, size, align) {
    ctx.font = `500 ${size}px Inter, system-ui, sans-serif`;
    const padX = size * 0.54, height = size * 1.72;
    const w = ctx.measureText(text).width + 2 * padX;
    const left = align === "right" ? x - w : align === "left" ? x : x - w / 2;
    ctx.save();
    ctx.fillStyle = "rgba(32, 33, 36, 0.55)";
    ctx.beginPath();
    ctx.roundRect(left, y - height, w, height, size * 0.31);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    // Détourage : halo flou, puis ombre décalée (text-shadow de la visionneuse)
    for (const [color, blur, dx, dy] of [["rgba(0, 0, 0, 0.9)", 2, 0, 0], ["rgba(0, 0, 0, 0.6)", 1, 1, 1]]) {
      const k = size / 13;
      Object.assign(ctx, { shadowColor: color, shadowBlur: blur * k, shadowOffsetX: dx * k, shadowOffsetY: dy * k });
      ctx.fillText(text, left + padX, y - height / 2);
    }
    ctx.restore();
  }

  return { cartouches, cartouche };
})();

export { Vignette };
