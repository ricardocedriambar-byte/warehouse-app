// lib/resources.js
//
// Auto-discovers price lists / supplier catalogs directly from Google
// Drive — no manual list to maintain. Folder structure (set up once in
// Drive, shared with the service account as Viewer):
//
//   Recursos/
//     <Nome do Fornecedor>/
//       <Nome do Documento>.pdf
//       ...
//     <Outro Fornecedor>/
//       ...
//
// Ricardo just drops a PDF into the right supplier subfolder and it
// shows up in the app on next load — nothing else to configure.
//
// Uses the same Google service account already set up for Sheets
// access (scope 'drive.readonly' is already granted there).

const { getAuthToken } = require('./sheets');

const ROOT_FOLDER_ID = process.env.RESOURCES_DRIVE_FOLDER_ID;
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// Fetches every file matching `query`, following pagination.
async function driveList(query, fields) {
  const accessToken = await getAuthToken();
  const files = [];
  let pageToken;

  do {
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken, files(${fields})`,
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

function stripPdfExt(name) {
  return name.replace(/\.pdf$/i, '');
}

// Accent/case-insensitive so "Tabela de Preços", "tabela de precos" or
// "TABELA DE PREÇOS 2026" all count as the price list — folder contents
// aren't guaranteed to be typed identically every time.
function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Every fornecedor folder is expected to have one "Tabela de Preços" PDF,
// and it should always lead that fornecedor's document list regardless of
// how its name sorts alphabetically against the rest.
function isTabelaDePrecos(nome) {
  return normalize(nome).startsWith('tabela de precos');
}

function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// Returns [{ fornecedor, nome, url, atualizado }, ...] — one entry per
// PDF found in any immediate subfolder of the root "Recursos" folder.
async function getResources() {
  if (!ROOT_FOLDER_ID) {
    throw new Error(
      'RESOURCES_DRIVE_FOLDER_ID is not set. Create a "Recursos" folder in ' +
      'Drive, share it (Viewer) with wharehouse-bot@webiste-gmail-smtp.iam.gserviceaccount.com, ' +
      'and set its folder ID as the RESOURCES_DRIVE_FOLDER_ID env var.'
    );
  }

  const folders = await driveList(
    `'${ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    'id, name'
  );

  const results = await Promise.all(folders.map(async folder => {
    const files = await driveList(
      `'${folder.id}' in parents and mimeType='application/pdf' and trashed=false`,
      'id, name, modifiedTime'
    );
    return files.map(f => ({
      fornecedor: folder.name,
      nome: stripPdfExt(f.name),
      // /preview (not /view) is Drive's iframe-embed URL — loading it
      // inside our own PDF viewer overlay means the browser never
      // navigates to drive.google.com at the top level, so mobile OSes
      // don't hand off to the Drive app / force a sign-in prompt, and
      // there's no size limit since Google serves the bytes directly.
      url: `https://drive.google.com/file/d/${f.id}/preview`,
      // Kept separately (rather than derived from `url` on the frontend)
      // so the "Partilhar" button can share Drive's normal /view link —
      // the one people can actually open outside the app — without the
      // frontend needing to know/guess Drive's URL scheme.
      fileId: f.id,
      atualizado: formatDate(f.modifiedTime)
    }));
  }));

  // Tabela de Preços first (within each fornecedor — see isTabelaDePrecos),
  // then everything else alphabetically. Sorting the flat list this way
  // and grouping by fornecedor afterwards (in the frontend) still lands
  // each fornecedor's own price list at the top of its own section, since
  // Array#sort is stable and grouping only filters, never reorders.
  return results.flat().sort((a, b) => {
    const aPriority = isTabelaDePrecos(a.nome) ? 0 : 1;
    const bPriority = isTabelaDePrecos(b.nome) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.nome.localeCompare(b.nome, 'pt');
  });
}

module.exports = { getResources };
