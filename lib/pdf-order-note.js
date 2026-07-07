// lib/pdf-order-note.js
//
// Fills the "Nota de Encomenda" template (a flat, non-fillable PDF — no
// AcroForm fields) with order data by drawing text at fixed coordinates
// measured directly off the template. If the template is ever redesigned,
// these coordinates need re-measuring (open it with pdfplumber in Python,
// or ask Claude to re-measure it the same way this was built).
//
// Requires the "pdf-lib" package: run `npm install pdf-lib` in the project.

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const PAGE_H = 841.92; // template page height in points (A4)

// pdfplumber (used to measure the template) gives y as distance from the
// TOP of the page; pdf-lib draws from the BOTTOM. This converts between them.
const toY = (topY) => PAGE_H - topY;

// Table geometry, measured from the template's vector grid lines.
const TABLE = {
  row0Top: 256.0,
  rowHeight: 14.35,
  maxRows: 13, // rows available before the "PAGAMENTO:" section starts
  cols: {
    pedido: 51, fornecido: 97, desc: 127,
    comp: 389, larg: 428, esp: 463, preco: 507, descpct: 557
  }
};

function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function centerText(page, font, text, size, centerX, topY) {
  if (!text) return;
  const width = font.widthOfTextAtSize(String(text), size);
  page.drawText(String(text), { x: centerX - width / 2, y: toY(topY), size, font });
}

// order:  the order object (orderId, createdAt, lines, ...)
// client: the full client record (id, name, address, phone, nif, ...)
// Returns a Uint8Array of the filled PDF's bytes.
async function buildOrderNotePdf(order, client) {
  const templatePath = path.join(__dirname, 'nota-encomenda-template.pdf');
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const SIZE = 9;
  const SMALL = 8;

  const draw = (text, x, topY, size = SIZE) => {
    if (!text) return;
    page.drawText(String(text), { x, y: toY(topY), size, font });
  };

  // ─── Header fields ───────────────────────────────────────────────────
  draw(order.orderId, 432, 93.4);
  draw(client?.id, 447, 111.8);
  draw(client?.name, 300, 134.8);
  draw(client?.address, 300, 153.2);
  draw(client?.phone, 300, 171.6);
  draw(client?.nif, 125, 190.0);

  const date = order.createdAt ? new Date(order.createdAt) : new Date();
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  centerText(page, font, dd,   SIZE, 101, 223.5);
  centerText(page, font, mm,   SIZE, 126, 223.5);
  centerText(page, font, yyyy, SIZE, 156, 223.5);

  // ─── Line items table ────────────────────────────────────────────────
  const allLines = order.lines || [];
  const lines = allLines.slice(0, TABLE.maxRows);

  lines.forEach((l, i) => {
    const rowTop   = TABLE.row0Top + i * TABLE.rowHeight;
    const baseline = rowTop + 10; // sit text ~10pt below the row's top gridline

    centerText(page, font, fmtNum(l.qtyOrdered), SMALL, TABLE.cols.pedido, baseline);
    page.drawText(String(l.descricao || '').slice(0, 52), {
      x: TABLE.cols.desc, y: toY(baseline), size: SMALL, font
    });
    if (l.comprimento) centerText(page, font, fmtNum(l.comprimento), SMALL, TABLE.cols.comp, baseline);
    if (l.largura)     centerText(page, font, fmtNum(l.largura),     SMALL, TABLE.cols.larg, baseline);
    if (l.espessura)   centerText(page, font, fmtNum(l.espessura),   SMALL, TABLE.cols.esp,  baseline);
    centerText(page, font, fmtNum(l.unitPrice, 2), SMALL, TABLE.cols.preco, baseline);
    centerText(page, font, '0', SMALL, TABLE.cols.descpct, baseline);
  });

  // If there are more lines than fit on the template, note it in the
  // observations box (x36–316, y719–890 roughly) rather than silently
  // dropping them.
  if (allLines.length > TABLE.maxRows) {
    draw(
      `+ ${allLines.length - TABLE.maxRows} artigo(s) adicionais — ver detalhe na app`,
      40, 725, SMALL
    );
  }

  // ─── Bottom "CLIENTE:" field (supplier-order section) ───────────────
  draw(client?.name, 78, 648.7);

  return pdfDoc.save();
}

module.exports = { buildOrderNotePdf };
