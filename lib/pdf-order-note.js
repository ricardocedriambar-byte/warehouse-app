// lib/pdf-order-note.js
//
// Fills the "Nota de Encomenda" template (a flat, non-fillable PDF — no
// AcroForm fields) with order data by drawing text at fixed coordinates
// measured directly off the template. If the template is ever redesigned,
// these coordinates need re-measuring (open it with pdfplumber in Python —
// page.extract_words() for label positions, page.lines for the grid — or
// ask Claude to re-measure it the same way this was built).
//
// Template: "nota_v7_twocol" design — Cliente / Condições Comerciais in
// two columns, then a full-width Artigos table with a Total column.
// Requires the "pdf-lib" package: run `npm install pdf-lib` in the project.

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_H = 841.89; // template page height in points (A4)

// pdfplumber (used to measure the template) gives y as distance from the
// TOP of the page; pdf-lib draws from the BOTTOM. This converts between them.
const toY = (topY) => PAGE_H - topY;

// Left column (Cliente) field underlines — measured off the template.
// Each entry's y is the underline's position; text is drawn just above it.
const CLIENTE_FIELDS = {
  nome:      194.1,
  numero:    222.3,
  nif:       250.5,
  morada:    278.7,
  telefone:  306.9,
  email:     335.1,
  vendedor:  363.3
};

// Right column (Condições Comerciais) — left intentionally unfilled below;
// there's no digital source for these yet (plafond, prazo, transporte…),
// same as the previous template. Kept here as a reference for a future
// order field, not currently drawn.
// const CONDICOES_FIELDS = { valor: 194.1, prazo: 222.3, transporte: 250.5, plafond: 278.7, conta: 306.9 };

const HEADER = {
  orderId: { x: 488, y: 128, eraseX0: 484, eraseX1: 548, eraseTop: 116, eraseBottom: 131 },
  date: {
    dayX: 480,   eraseDayX0: 470, eraseDayX1: 489,
    monthX: 505, eraseMonthX0: 494, eraseMonthX1: 513,
    yearX: 535,  eraseYearX0: 518, eraseYearX1: 549,
    y: 141, eraseTop: 129, eraseBottom: 144
  }
};

// Item table geometry — header bottom border at 401.7, then one line per
// row every 22.3pt down to 647.1 (11 rows).
const TABLE = {
  firstRowBottom: 424.1,
  rowHeight: 22.3,
  maxRows: 11,
  cols: {
    qtdPed:  { x0: 45.0,  x1: 82.8  },
    qtdForn: { x0: 82.8,  x1: 120.6 },
    sku:     { x0: 120.6, x1: 162.8 },
    desc:    { x0: 167.9, x1: 351.4 }, // left-aligned, not centered
    comp:    { x0: 351.4, x1: 381.7 },
    larg:    { x0: 381.7, x1: 411.9 },
    esp:     { x0: 411.9, x1: 442.2 },
    preco:   { x0: 442.2, x1: 479.0 },
    descPct: { x0: 479.0, x1: 511.4 },
    total:   { x0: 511.4, x1: 550.3 }
  }
};

const OBS_LINE_Y = 684.8;
const GREY = rgb(0.38, 0.38, 0.38);

function colCenter(col) { return (col.x0 + col.x1) / 2; }

function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Quantity + unit together (e.g. "12 un", "0,850 m2") — units other than
// "un" are area/length/volume measures, so they keep 3 decimals; "un" is
// always a whole count. Falls back to "un" when no unit is set.
// Superscript ²/³ are normalized to plain 2/3: pdf-lib's standard
// Helvetica font silently drops those glyphs instead of drawing them.
function fmtQty(qty, unidade) {
  const unit = (unidade || 'un').replace('²', '2').replace('³', '3');
  if (unit === 'un') {
    // Whole counts stay whole ("5 un"); a fractional count someone
    // actually typed ("2,5 un") is shown as-is instead of being rounded.
    const n = Number(qty) || 0;
    return `${Number.isInteger(n) ? fmtNum(n, 0) : n.toLocaleString('pt-PT', { maximumFractionDigits: 3 })} ${unit}`;
  }
  return `${fmtNum(qty, 3)} ${unit}`;
}

// What goes in the "Qtd. Ped." column. The sheet always stores
// qtyOrdered in the item's PRICING unit (m² for panels) — that's what
// stock/reservations/totals run on — but the vendedor may have entered
// the quantity in a different unit (e.g. "5 un" of a panel sold by m²).
// When that's the case (qtyMode/qtyEntered, saved alongside the line),
// the note shows exactly what was chosen in the app as the main value,
// with the pricing-unit equivalent underneath so the Total still adds up.
// Older orders saved before qtyMode/qtyEntered existed just show
// qtyOrdered in its own unit, same as before.
function qtyDisplay(l) {
  const unidade = l.unidade || 'un';
  const mode = l.qtyMode;
  const entered = Number(l.qtyEntered);
  if (mode && mode !== unidade && Number.isFinite(entered) && entered > 0) {
    return { primary: fmtQty(entered, mode), secondary: fmtQty(l.qtyOrdered, unidade), convertedFrom: true };
  }
  return { primary: fmtQty(l.qtyOrdered, unidade), secondary: '', convertedFrom: false };
}

function centerText(page, font, text, size, centerX, topY, color) {
  if (!text && text !== 0) return;
  const str = String(text);
  const width = font.widthOfTextAtSize(str, size);
  const opts = { x: centerX - width / 2, y: toY(topY), size, font };
  if (color) opts.color = color;
  page.drawText(str, opts);
}

// Like centerText, but shrinks the font (down to minSize) until the text
// fits within maxWidth — used for the qty+unit column, where "0,850 m²"
// needs more room than "4 un" but the column can't grow.
function centerTextFit(page, font, text, preferredSize, centerX, topY, maxWidth, minSize = preferredSize - 2, color) {
  if (!text && text !== 0) return;
  const str = String(text);
  let size = preferredSize;
  while (size > minSize && font.widthOfTextAtSize(str, size) > maxWidth) size -= 0.5;
  centerText(page, font, str, size, centerX, topY, color);
}

// Greedy word-wrap into at most `maxLines` lines that each fit maxWidth.
// Returns null when the text can't fit in that many lines at this size
// (so the caller can try a smaller size / more lines) — never truncates.
function wrapToLines(font, text, size, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (let w of words) {
    // A single word wider than the whole column (e.g. a long code with no
    // spaces) is hard-split across lines rather than overflowing.
    while (font.widthOfTextAtSize(w, size) > maxWidth) {
      if (current) { lines.push(current); current = ''; }
      let lo = 1, hi = w.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (font.widthOfTextAtSize(w.slice(0, mid), size) <= maxWidth) lo = mid; else hi = mid - 1;
      }
      lines.push(w.slice(0, lo));
      w = w.slice(lo);
      if (lines.length > maxLines) return null;
    }
    const candidate = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = w;
    }
    if (lines.length > maxLines) return null;
  }
  if (current) lines.push(current);
  return lines.length <= maxLines ? lines : null;
}

// Draws a table cell's text so ALL of it is readable inside the row —
// no "…" truncation. Tries progressively smaller sizes and more lines
// (1 line → 2 lines → 3 lines) until the whole text fits the cell's
// width and the row's height, then centers the block vertically in the
// row. Leading whitespace (the indent on door-component child lines) is
// kept as an x-offset on every line.
function drawFittedCellText(page, font, text, x0, maxWidth, rowTop, rowBottom, baseSize) {
  const raw = String(text || '');
  const indentMatch = /^\s*/.exec(raw);
  const body = raw.slice(indentMatch[0].length).trim();
  if (!body) return;

  const rowH = rowBottom - rowTop;
  const attempts = [];
  for (let size = baseSize; size >= 7.5; size -= 0.5) attempts.push({ size, lines: 1 });
  for (let size = Math.min(baseSize, 8.5); size >= 6; size -= 0.5) attempts.push({ size, lines: 2 });
  for (let size = 6.5; size >= 4; size -= 0.5) attempts.push({ size, lines: 3 });

  const layoutFor = ({ size, lines: maxLines }) => {
    const indentW = indentMatch[0] ? font.widthOfTextAtSize(indentMatch[0], size) : 0;
    const width = maxWidth - indentW;
    const lines = wrapToLines(font, body, size, width, maxLines);
    if (!lines) return null;
    const lead = size * 1.12;
    const cap = size * 0.72;
    const blockH = (lines.length - 1) * lead + cap;
    if (blockH > rowH - 2) return null;
    return { size, lines, lead, cap, blockH, indentW };
  };

  let layout = null;
  for (const a of attempts) { layout = layoutFor(a); if (layout) break; }
  if (!layout) {
    // Pathologically long text — last resort, smallest size, as many
    // lines as physically fit, truncated only then.
    const size = 4, lead = size * 1.12, cap = size * 0.72;
    const fit = Math.max(1, Math.floor((rowH - 2 - cap) / lead) + 1);
    let lines = wrapToLines(font, body, size, maxWidth, 99) || [body];
    if (lines.length > fit) {
      lines = lines.slice(0, fit);
      lines[fit - 1] = truncateToWidth(font, lines[fit - 1] + ' …', size, maxWidth);
    }
    layout = { size, lines, lead, cap, blockH: (lines.length - 1) * lead + cap, indentW: 0 };
  }

  const top = rowTop + (rowH - layout.blockH) / 2;
  layout.lines.forEach((line, i) => {
    page.drawText(line, {
      x: x0 + layout.indentW,
      y: toY(top + layout.cap + i * layout.lead),
      size: layout.size, font
    });
  });
}

// Truncates text (with an ellipsis) so it never exceeds maxWidth at the
// given font/size — a fixed character-count slice isn't reliable here
// since bold caps/digits are wide and descriptions vary a lot in length
// (a plain SKU description vs. a long "BLOCO ..." door-block line).
function truncateToWidth(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + '…';
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

// Greedy word-wrap of `text` into at most 2 lines that each fit within
// maxWidth at the given size. Long single "words" (e.g. a run-together
// phone number with no space) get hard-split instead of overflowing.
function wrapToTwoLines(font, text, size, maxWidth) {
  const words = text.split(' ');
  let line1 = '';
  let i = 0;
  for (; i < words.length; i++) {
    const candidate = line1 ? `${line1} ${words[i]}` : words[i];
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line1 = candidate;
    } else if (!line1) {
      // A single word already overflows the whole width — hard-split it
      // by character instead of leaving line1 empty.
      let lo = 0, hi = words[i].length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (font.widthOfTextAtSize(words[i].slice(0, mid), size) <= maxWidth) lo = mid; else hi = mid - 1;
      }
      line1 = words[i].slice(0, lo);
      words[i] = words[i].slice(lo);
      i--; // reconsider the remainder of this word for line2
      break;
    } else {
      break;
    }
  }
  let line2 = words.slice(i).join(' ');
  if (font.widthOfTextAtSize(line2, size) > maxWidth) {
    line2 = truncateToWidth(font, line2, size, maxWidth);
  }
  return [line1, line2];
}

// Draws a Cliente-column field value that sits just above its underline,
// shrinking the font and/or wrapping onto 2 lines when the text is too
// long for the column at the normal size — long addresses and dual phone
// numbers otherwise ran right up against (or past) the column edge.
function drawFieldValue(page, font, text, x0, x1, underlineY, preferredSize) {
  if (!text) return;
  const str = String(text);
  const maxWidth = x1 - x0 - 4;

  if (font.widthOfTextAtSize(str, preferredSize) <= maxWidth) {
    page.drawText(str, { x: x0, y: toY(underlineY - 6), size: preferredSize, font });
    return;
  }

  const smallSize = preferredSize - 1.5;
  if (font.widthOfTextAtSize(str, smallSize) <= maxWidth) {
    // Fits on one line once shrunk — no need to wrap.
    page.drawText(str, { x: x0, y: toY(underlineY - 5), size: smallSize, font });
    return;
  }

  const [line1, line2] = wrapToTwoLines(font, str, smallSize, maxWidth);
  page.drawText(line1, { x: x0, y: toY(underlineY - 14), size: smallSize, font });
  page.drawText(line2, { x: x0, y: toY(underlineY - 5),  size: smallSize, font });
}

// Covers a region with a solid white rectangle — used to blank out the
// template's own pre-printed "______" placeholder characters before
// writing the real value on top of them (otherwise the underscores show
// through, interleaved with the text).
function eraseArea(page, x0, x1, topY0, topY1) {
  page.drawRectangle({
    x: x0, y: toY(topY1), width: x1 - x0, height: topY1 - topY0,
    color: rgb(1, 1, 1)
  });
}

// order:  the order object (orderId, createdAt, lines, salesperson, ...)
// client: the full client record (id, name, address, phone, email, nif, ...)
// Returns a Uint8Array of the filled PDF's bytes.
async function buildOrderNotePdf(order, client) {
  const templatePath = path.join(__dirname, 'nota-encomenda-template.pdf');
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const SIZE  = 10;
  const SMALL = 9;

  const draw = (text, x, topY, size = SIZE) => {
    if (!text && text !== 0) return;
    page.drawText(String(text), { x, y: toY(topY), size, font });
  };

  // ─── Header: order number + date ────────────────────────────────────
  eraseArea(page, HEADER.orderId.eraseX0, HEADER.orderId.eraseX1, HEADER.orderId.eraseTop, HEADER.orderId.eraseBottom);
  draw(order.orderId, HEADER.orderId.x, HEADER.orderId.y);

  const date = order.createdAt ? new Date(order.createdAt) : new Date();
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  eraseArea(page, HEADER.date.eraseDayX0,   HEADER.date.eraseDayX1,   HEADER.date.eraseTop, HEADER.date.eraseBottom);
  eraseArea(page, HEADER.date.eraseMonthX0, HEADER.date.eraseMonthX1, HEADER.date.eraseTop, HEADER.date.eraseBottom);
  eraseArea(page, HEADER.date.eraseYearX0,  HEADER.date.eraseYearX1,  HEADER.date.eraseTop, HEADER.date.eraseBottom);
  centerText(page, font, dd,   SIZE, HEADER.date.dayX,   HEADER.date.y);
  centerText(page, font, mm,   SIZE, HEADER.date.monthX, HEADER.date.y);
  centerText(page, font, yyyy, SIZE, HEADER.date.yearX,  HEADER.date.y);

  // ─── Cliente ─────────────────────────────────────────────────────────
  const CLIENTE_FIELD_X0 = 55.9;
  const CLIENTE_FIELD_X1 = 282.7; // measured underline end in the template
  const drawField = (text, underlineY, size = SIZE) =>
    drawFieldValue(page, font, text, CLIENTE_FIELD_X0, CLIENTE_FIELD_X1, underlineY, size);

  drawField(client?.name, CLIENTE_FIELDS.nome);
  drawField(client?.id,   CLIENTE_FIELDS.numero);
  drawField(client?.nif,  CLIENTE_FIELDS.nif);
  drawField(client?.address, CLIENTE_FIELDS.morada, SMALL);
  drawField(client?.phone, CLIENTE_FIELDS.telefone);
  drawField(client?.email, CLIENTE_FIELDS.email, SMALL);
  drawField(order.salesperson, CLIENTE_FIELDS.vendedor);

  // Condições Comerciais (valor aproximado, prazo, transporte, plafond,
  // conta corrente) are intentionally left blank — no digital source for
  // them yet, filled in by hand same as before.

  // ─── Line items table ────────────────────────────────────────────────
  const allLines = order.lines || [];
  const lines = allLines.slice(0, TABLE.maxRows);

  lines.forEach((l, i) => {
    const rowBottom = TABLE.firstRowBottom + i * TABLE.rowHeight;
    const baseline = rowBottom - 6;
    const descText = String(l.descricao || '');
    // Door-component lines (Aduela/Guarnição/Bite) come indented with
    // their piece count already folded into the text ("— 6 pç"), so the
    // Qtd. Ped. column is left blank for them and they render a touch
    // smaller — keeps that column meaningful for the parent BLOCO line
    // (and for normal catalog items) instead of repeating the same count
    // in two places.
    const isChildLine = /^\s/.test(descText);
    const isDoorLine = /^PORTA-/.test(l.sku || '');

    const rowTop = rowBottom - TABLE.rowHeight;
    const qty = qtyDisplay(l);
    if (!isChildLine) {
      const qtyMaxWidth = TABLE.cols.qtdPed.x1 - TABLE.cols.qtdPed.x0 - 4;
      if (qty.secondary) {
        // Two stacked values: what was chosen in the app (main), and its
        // pricing-unit equivalent (smaller, grey) — e.g. "5 un" / "28,980 m2".
        centerTextFit(page, font, qty.primary, SMALL, colCenter(TABLE.cols.qtdPed), rowBottom - 11.5, qtyMaxWidth, 6);
        centerTextFit(page, font, qty.secondary, 6.5, colCenter(TABLE.cols.qtdPed), rowBottom - 3.5, qtyMaxWidth, 4.5, GREY);
      } else {
        centerTextFit(page, font, qty.primary, SMALL, colCenter(TABLE.cols.qtdPed), baseline, qtyMaxWidth, 6);
      }
    }
    if (!isDoorLine && l.sku) {
      centerText(page, font, l.sku, SMALL - 1, colCenter(TABLE.cols.sku), baseline);
    }
    const descMaxWidth = TABLE.cols.desc.x1 - TABLE.cols.desc.x0 - 4;
    const baseSize = isChildLine ? SMALL - 1 : SMALL;
    drawFittedCellText(page, font, descText, TABLE.cols.desc.x0, descMaxWidth, rowTop, rowBottom, baseSize);
    if (l.comprimento) centerText(page, font, fmtNum(l.comprimento), SMALL, colCenter(TABLE.cols.comp), baseline);
    if (l.largura)     centerText(page, font, fmtNum(l.largura),     SMALL, colCenter(TABLE.cols.larg), baseline);
    if (l.espessura)   centerText(page, font, fmtNum(l.espessura),   SMALL, colCenter(TABLE.cols.esp),  baseline);
    if (l.unitPrice) {
      if (qty.convertedFrom) {
        // Quantity was entered in a different unit than the price is
        // quoted in — label the price's unit so "5 un × 10,00" isn't
        // misread (the price is per m², not per panel).
        const priceUnit = '/' + String(l.unidade || 'un').replace('²', '2').replace('³', '3');
        centerText(page, font, fmtNum(l.unitPrice, 2), SMALL, colCenter(TABLE.cols.preco), rowBottom - 11.5);
        centerText(page, font, priceUnit, 6.5, colCenter(TABLE.cols.preco), rowBottom - 3.5, GREY);
      } else {
        centerText(page, font, fmtNum(l.unitPrice, 2), SMALL, colCenter(TABLE.cols.preco), baseline);
      }
      centerText(page, font, fmtNum(l.discountPct || 0), SMALL, colCenter(TABLE.cols.descPct), baseline);
      const discounted = l.qtyOrdered * l.unitPrice * (1 - (l.discountPct || 0) / 100);
      centerText(page, font, fmtNum(discounted, 2), SMALL, colCenter(TABLE.cols.total), baseline);
    }
  });

  // If there are more lines than fit on the template, note it on the
  // observations line rather than silently dropping them.
  const overflowNote = allLines.length > TABLE.maxRows
    ? `+ ${allLines.length - TABLE.maxRows} artigo(s) adicionais — ver detalhe na app. `
    : '';
  const obsText = (overflowNote + (order.orderNotes || '')).trim();
  if (obsText) draw(obsText.slice(0, 95), 50.5, OBS_LINE_Y - 6, SMALL);

  return pdfDoc.save();
}

module.exports = { buildOrderNotePdf, qtyDisplay, fmtQty };
