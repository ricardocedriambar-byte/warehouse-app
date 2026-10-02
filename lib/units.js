// lib/units.js
//
// How much of an item's selling unit one physical piece holds — the rule
// that decides whether STOCK/RESERVADO are counted in pieces (when this
// returns a number) or directly in the selling unit (when it returns null).
// Mirrors qtyPerPiece() in public/app.js; keep the two in sync.
//
//   m²  → DIMENSÃO M² (or comprimento × largura)
//   ml  → comprimento (a 2200 mm rodapé = 2,2 ml)
//   m³  → comprimento × largura × espessura
//   lt  → DIMENSÃO M² column, which holds the litres per container
//   un  → null (already pieces)
//
// Accepts either app-shaped items ({ dimensaoM2 }) or raw rows ({ dimensao_m2 }).
function qtyPerPiece(x) {
  if (!x) return null;
  const u = x.unidade || 'un';
  const pos = (v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? n : null;
  };
  const c = pos(x.comprimento), l = pos(x.largura), e = pos(x.espessura);
  const d = pos(x.dimensaoM2 !== undefined ? x.dimensaoM2 : x.dimensao_m2);
  if (u === 'm²') return d || (c && l ? (c * l) / 1e6 : null);
  if (u === 'ml') return c ? c / 1000 : null;
  if (u === 'm³') return (c && l && e) ? (c * l * e) / 1e9 : null;
  if (u === 'lt') return d;
  return null;
}

// Quantity in the selling unit (an order line's qtyOrdered / qtyPicked) →
// the number STOCK/RESERVADO are kept in.
function toPieces(item, qtyInSellingUnit) {
  const pp = qtyPerPiece(item);
  return pp ? qtyInSellingUnit / pp : qtyInSellingUnit;
}

module.exports = { qtyPerPiece, toPieces };
