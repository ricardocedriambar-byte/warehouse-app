// lib/db.js
//
// Postgres (Supabase) connection shared by every serverless function.
//
// DATABASE_URL should be Supabase's *Transaction pooler* connection string
// (port 6543) — serverless functions open and drop connections constantly,
// and the pooler is what keeps that from exhausting Postgres' own
// connection limit. Transaction mode doesn't support prepared statements,
// hence `prepare: false`.
//
// USE_POSTGRES=1 switches lib/sheets.js (artigos, stock, histórico) and
// lib/orders.js (encomendas) over to this database. Unset (or 0) keeps the
// old Google Sheets code paths — a one-env-var rollback.

const postgres = require('postgres');

let sql = null;

function usePostgres() {
  const v = String(process.env.USE_POSTGRES || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function getSql() {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  sql = postgres(url, {
    prepare: false,
    max: 3,                 // per warm function instance; the pooler multiplexes
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: /localhost|127\.0\.0\.1|host=\/tmp/.test(url) ? false : 'require',
    // numeric → JS number (default is string). Quantities/prices here are
    // small decimals well inside double precision.
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x) => String(x),
        parse: (x) => (x === null ? null : Number(x))
      }
    }
  });
  return sql;
}

// For tests: replace/clear the shared client.
function _setSql(client) { sql = client; }

function isoOrEmpty(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

module.exports = { getSql, usePostgres, isoOrEmpty, _setSql };
