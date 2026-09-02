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
    qtdPed:  { x0: 45.0,  x1: 87.1  },
    qtdForn: { x0: 87.1,  x1: 129.3 },
    desc:    { x0: 134.3, x1: 329.3 }, // left-aligned, not centered
    comp:    { x0: 329.3, x1: 362.8 },
    larg:    { x0: 362.8, x1: 396.3 },
    esp:     { x0: 396.3, x1: 429.8 },
    preco:   { x0: 429.8, x1: 471.9 },
    descPct: { x0: 471.9, x1: 507.0 },
    total:   { x0: 507.0, x1: 550.3 }
  }
};

const OBS_LINE_Y = 684.8;

function colCenter(col) { return (col.x0 + col.x1) / 2; }

function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function centerText(page, font, text, size, centerX, topY) {
  if (!text && text !== 0) return;
  const str = String(text);
  const width = font.widthOfTextAtSize(str, size);
  page.drawText(str, { x: centerX - width / 2, y: toY(topY), size, font });
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
  const drawAbove = (text, x, underlineY, size = SIZE) => draw(text, x, underlineY - 6, size);

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
  drawAbove(client?.name, 55.9, CLIENTE_FIELDS.nome);
  drawAbove(client?.id,   55.9, CLIENTE_FIELDS.numero);
  drawAbove(client?.nif,  55.9, CLIENTE_FIELDS.nif);
  drawAbove(client?.address, 55.9, CLIENTE_FIELDS.morada, SMALL);
  drawAbove(client?.phone, 55.9, CLIENTE_FIELDS.telefone);
  drawAbove(client?.email, 55.9, CLIENTE_FIELDS.email, SMALL);
  drawAbove(order.salesperson, 55.9, CLIENTE_FIELDS.vendedor);

  // Condições Comerciais (valor aproximado, prazo, transporte, plafond,
  // conta corrente) are intentionally left blank — no digital source for
  // them yet, filled in by hand same as before.

  // ─── Line items table ────────────────────────────────────────────────
  const allLines = order.lines || [];
  const lines = allLines.slice(0, TABLE.maxRows);

  lines.forEach((l, i) => {
    const rowBottom = TABLE.firstRowBottom + i * TABLE.rowHeight;
    const baseline = rowBottom - 6;

    centerText(page, font, fmtNum(l.qtyOrdered, (l.unidade === 'un' || !l.unidade) ? 0 : 3), SMALL, colCenter(TABLE.cols.qtdPed), baseline);
    page.drawText(String(l.descricao || '').slice(0, 46), {
      x: TABLE.cols.desc.x0, y: toY(baseline), size: SMALL, font
    });
    if (l.comprimento) centerText(page, font, fmtNum(l.comprimento), SMALL, colCenter(TABLE.cols.comp), baseline);
    if (l.largura)     centerText(page, font, fmtNum(l.largura),     SMALL, colCenter(TABLE.cols.larg), baseline);
    if (l.espessura)   centerText(page, font, fmtNum(l.espessura),   SMALL, colCenter(TABLE.cols.esp),  baseline);
    if (l.unitPrice) {
      centerText(page, font, fmtNum(l.unitPrice, 2), SMALL, colCenter(TABLE.cols.preco), baseline);
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

module.exports = { buildOrderNotePdf };
