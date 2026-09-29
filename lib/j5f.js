// lib/j5f.js
//
// Server side of the read-only J5F → app sync.
//
// A small PowerShell script (tools/j5f-sync/j5f-sync.ps1) runs on the office
// PC, reads the J5F dBase files (VENPROD.DBF, VENCLIEN.DBF) strictly
// read-only, and POSTs the data here. Nothing ever flows back to J5F.
//
//   POST /api/sync-prices?source=j5f[&dryRun=1]   body: { products: [...] }
//   POST /api/clients?sync=j5f[&dryRun=1]         body: { clients:  [...] }
//
// Both require J5F_SYNC_SECRET (Authorization: Bearer <secret>). Unlike the
// TABELA cron, these endpoints write data taken from the request body, so
// they refuse to run at all when no secret is configured.

const { sheetsFetch } = require('./sheets');

const CLIENTS_TAB = 'Clientes';

function isJ5fAuthorized(req) {
  const secret = process.env.J5F_SYNC_SECRET;
  if (!secret) return false;
  return req.headers['authorization'] === `Bearer ${secret}`;
}

function normalizeSku(raw) {
  const str = String(raw ?? '').trim();
  if (!/^\d+$/.test(str)) return null;
  return str.padStart(8, '0');
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Turns the products payload into the same { prices, unmatched, duplicates }
// shape lib/priceList.js returns for TABELA.xlsx, so api/sync-prices.js can
// run the exact same compare-and-write logic for both sources.
function parseJ5fProducts(body) {
  const list = Array.isArray(body && body.products) ? body.products : null;
  if (!list) throw new Error('Body must be { products: [...] }');

  const prices = new Map();
  const unmatched = [];
  const occurrencesBySku = new Map();

  list.forEach((p, idx) => {
    const preco = toNumberOrNull(p.preco);
    if (preco === null || preco <= 0) return;
    const sku = normalizeSku(p.sku);
    if (!sku) {
      unmatched.push({ row: idx + 1, descricao: p.descricao || String(p.sku || ''), preco });
      return;
    }
    const valorCompra = toNumberOrNull(p.valorCompra);
    if (!occurrencesBySku.has(sku)) occurrencesBySku.set(sku, []);
    occurrencesBySku.get(sku).push({ row: idx + 1, preco, codigo: String(p.sku) });
    prices.set(sku, { preco, valorCompra: valorCompra && valorCompra > 0 ? valorCompra : null, descricao: p.descricao || '' });
  });

  const duplicates = [];
  for (const [sku, occurrences] of occurrencesBySku) {
    if (occurrences.length > 1) {
      const distinct = new Set(occurrences.map((o) => o.preco));
      duplicates.push({ sku, occurrences, conflicting: distinct.size > 1 });
    }
  }
  return { prices, unmatched, duplicates };
}

// Same NIF convention as lib/orders.js (NIF lives inside Notas as text).
function extractNif(notes) {
  if (!notes) return '';
  const m = String(notes).match(/NIF[:\s]*([0-9][0-9.\s]*[0-9]|[0-9])/i);
  return m ? m[1].replace(/[.\s]/g, '') : '';
}

function colLetter(i) { return 'ABCDEF'[i]; }

// Upserts J5F clients into the Clientes tab.
// - Clients whose J5F code isn't in the tab yet are appended.
// - Existing clients only get EMPTY cells filled in (name, morada,
//   telefone, email, NIF). Anything already typed in the app is never
//   overwritten, and no client is ever deleted.
async function syncJ5fClients(body, { dryRun = false } = {}) {
  const list = Array.isArray(body && body.clients) ? body.clients : null;
  if (!list) throw new Error('Body must be { clients: [...] }');

  const data = await sheetsFetch(`/values/${encodeURIComponent(`${CLIENTS_TAB}!A2:F`)}`);
  const rows = data.values || [];
  const byId = new Map();
  rows.forEach((r, i) => {
    const id = String(r[0] || '').trim();
    if (id && !byId.has(id)) byId.set(id, { rowNumber: i + 2, row: r });
  });

  const summary = { total: 0, added: 0, filled: 0, unchanged: 0, skipped: 0, sampleAdded: [], sampleFilled: [] };
  const toAppend = [];
  const cellUpdates = [];
  const seen = new Set();

  for (const c of list) {
    const id = String(c.codigo || '').trim();
    const name = String(c.nome || '').trim();
    if (!id || id.startsWith('*') || !name || seen.has(id)) { summary.skipped++; continue; }
    seen.add(id);
    summary.total++;

    const address = String(c.morada || '').trim();
    const phone = String(c.telefone || '').trim();
    const email = String(c.email || '').trim();
    const nif = String(c.nif || '').replace(/\D/g, '');

    const existing = byId.get(id);
    if (!existing) {
      toAppend.push([id, name, address, phone, email, nif ? `NIF: ${nif}` : '']);
      summary.added++;
      if (summary.sampleAdded.length < 20) summary.sampleAdded.push(`${id} · ${name}`);
      continue;
    }

    const r = existing.row;
    const cur = (i) => String(r[i] || '').trim();
    const changes = [];
    [[1, name], [2, address], [3, phone], [4, email]].forEach(([i, val]) => {
      if (!cur(i) && val) changes.push([i, val]);
    });
    if (nif && !extractNif(cur(5))) {
      changes.push([5, cur(5) ? `NIF: ${nif} · ${cur(5)}` : `NIF: ${nif}`]);
    }
    if (changes.length === 0) { summary.unchanged++; continue; }
    summary.filled++;
    if (summary.sampleFilled.length < 20) summary.sampleFilled.push(`${id} · ${cur(1) || name}`);
    for (const [i, val] of changes) {
      cellUpdates.push({ range: `${CLIENTS_TAB}!${colLetter(i)}${existing.rowNumber}`, values: [[val]] });
    }
  }

  if (!dryRun) {
    for (let i = 0; i < cellUpdates.length; i += 500) {
      await sheetsFetch('/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: cellUpdates.slice(i, i + 500) })
      });
    }
    for (let i = 0; i < toAppend.length; i += 500) {
      await sheetsFetch(
        `/values/${encodeURIComponent(`${CLIENTS_TAB}!A:F`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: toAppend.slice(i, i + 500) }) }
      );
    }
  }

  return { ok: true, dryRun, ...summary };
}

module.exports = { isJ5fAuthorized, parseJ5fProducts, syncJ5fClients, normalizeSku, extractNif };
