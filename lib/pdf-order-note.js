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

// The "Data | Telemóvel | Telefone | Fax." box — measured the same way.
const CONTACT_ROW = {
  baseline: 223.5,
  cols: { data: 130, telemovel: 238.6, telefone: 346.7, fax: 454.8 }
};

function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// The template has 3 blank recipient lines (name / street / spare) plus,
// on the same row as N.º Contribuinte, two more separate blanks for
// Código Postal and Localidade. Client addresses come in as one free-text
// string (e.g. "Rua Exemplo, 123, 3500-000 Viseu"), so split it at the
// Portuguese postal code pattern (NNNN-NNN) into its three parts.
function splitAddress(address) {
  if (!address) return { street: '', postal: '', locality: '' };
  const m = String(address).match(/^(.*?),?\s*(\d{4}-\d{3})[,\s]*(.*)$/);
  if (m) return { street: m[1].trim(), postal: m[2].trim(), locality: m[3].trim() };
  return { street: address, postal: '', locality: '' };
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
  // Bold, and a bit larger than the template's own printed text, so filled-in
  // data reads clearly against the pre-printed labels/lines.
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const SIZE  = 10;
  const SMALL = 9;

  const draw = (text, x, topY, size = SIZE) => {
    if (!text) return;
    page.drawText(String(text), { x, y: toY(topY), size, font });
  };

  // ─── Header fields ───────────────────────────────────────────────────
  draw(order.orderId, 432, 93.4);
  draw(client?.id, 447, 111.8);
  draw(client?.name, 300, 134.8);
  const { street, postal, locality } = splitAddress(client?.address);
  draw(street, 300, 153.2);
  draw(client?.nif, 125, 190.0);
  centerText(page, font, postal, SIZE, 330, 190.0);
  draw(locality, 382, 190.0);

  const date = order.createdAt ? new Date(order.createdAt) : new Date();
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  centerText(page, font, dd,   SIZE, 101, CONTACT_ROW.baseline);
  centerText(page, font, mm,   SIZE, 126, CONTACT_ROW.baseline);
  centerText(page, font, yyyy, SIZE, 156, CONTACT_ROW.baseline);
  // Phone goes in the actual "Telemóvel" cell of this same row — smaller,
  // since a full number needs to fit inside the ~108pt-wide cell.
  centerText(page, font, client?.phone, 8, CONTACT_ROW.cols.telemovel, CONTACT_ROW.baseline);

  // ─── Line items table ────────────────────────────────────────────────
  const allLines = order.lines || [];
  const lines = allLines.slice(0, TABLE.maxRows);

  lines.forEach((l, i) => {
    const rowTop   = TABLE.row0Top + i * TABLE.rowHeight;
    const baseline = rowTop + 10; // sit text ~10pt below the row's top gridline

    centerText(page, font, fmtNum(l.qtyOrdered, (l.unidade === 'un' || !l.unidade) ? 0 : 3), SMALL, TABLE.cols.pedido, baseline);
    page.drawText(String(l.descricao || '').slice(0, 44), {
      x: TABLE.cols.desc, y: toY(baseline), size: SMALL, font
    });
    if (l.comprimento) centerText(page, font, fmtNum(l.comprimento), SMALL, TABLE.cols.comp, baseline);
    if (l.largura)     centerText(page, font, fmtNum(l.largura),     SMALL, TABLE.cols.larg, baseline);
    if (l.espessura)   centerText(page, font, fmtNum(l.espessura),   SMALL, TABLE.cols.esp,  baseline);
    centerText(page, font, fmtNum(l.unitPrice, 2), SMALL, TABLE.cols.preco, baseline);
    centerText(page, font, fmtNum(l.discountPct || 0), SMALL, TABLE.cols.descpct, baseline);
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

  // Note: the bottom "CLIENTE:" field (in the "ENCOMENDA AO FORNECEDOR"
  // section) is intentionally left blank — that section is for Cedriâmbar's
  // own order to its supplier, filled in by hand, not by this client note.

  return pdfDoc.save();
}

module.exports = { buildOrderNotePdf };
