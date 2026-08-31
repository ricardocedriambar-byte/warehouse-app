// resources.js — Recursos (tabelas de preços e catálogos de fornecedores)
//
// Read-only tab: the PDFs themselves live in Google Drive, auto-discovered
// from the folder structure (see lib/resources.js). Two-level view: a
// compact clickable list of fornecedores, then that fornecedor's documents.
// Vendedor-only — wired in app.js / hidden via applyRoleRestrictions().

let resourcesRendered = false;
let resourcesGroups = null; // Map<fornecedor, item[]>, filled once on first load

async function renderResourcesPanel() {
  const root = document.getElementById('recursos-panel');
  if (!root) return;
  if (resourcesRendered) return;
  resourcesRendered = true;

  root.innerHTML = `
    <div class="resources-view">
      <div class="resources-view__header" id="resources-header">
        <h2 class="resources-view__title">Recursos</h2>
      </div>
      <div id="resources-list" class="resources-list">
        <div class="resources__loading">A carregar recursos…</div>
      </div>
    </div>
  `;

  await loadResources();
}

function resEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function loadResources() {
  const list = document.getElementById('resources-list');
  if (!list) return;

  try {
    const res = await fetch('/api/resources');
    const data = await res.json();
    const items = data.resources || [];

    if (!items.length) {
      list.innerHTML = `<div class="resources__empty">Ainda não há recursos. Adiciona PDFs às pastas dos fornecedores no Drive.</div>`;
      return;
    }

    resourcesGroups = new Map();
    for (const item of items) {
      if (!resourcesGroups.has(item.fornecedor)) resourcesGroups.set(item.fornecedor, []);
      resourcesGroups.get(item.fornecedor).push(item);
    }

    renderFornecedoresList();
  } catch (err) {
    console.error('Falha ao carregar recursos', err);
    list.innerHTML = `<div class="resources__empty" style="color:var(--danger)">Não foi possível carregar os recursos.</div>`;
  }
}

function renderFornecedoresList() {
  const header = document.getElementById('resources-header');
  const list = document.getElementById('resources-list');
  if (!header || !list) return;

  header.innerHTML = `<h2 class="resources-view__title">Recursos</h2>`;

  const fornecedores = Array.from(resourcesGroups.keys()).sort((a, b) => a.localeCompare(b, 'pt'));

  list.innerHTML = fornecedores.map(fornecedor => `
    <button class="resources-supplier-row" data-fornecedor="${resEsc(fornecedor)}">
      <span class="resources-supplier-row__icon" data-icon-for="${resEsc(fornecedor)}">🏭</span>
      <span class="resources-supplier-row__nome">${resEsc(fornecedor)}</span>
      <span class="resources-supplier-row__count">${resourcesGroups.get(fornecedor).length}</span>
      <span class="resources-supplier-row__chevron">›</span>
    </button>
  `).join('');

  list.querySelectorAll('.resources-supplier-row').forEach(btn => {
    btn.addEventListener('click', () => renderFornecedorDocs(btn.dataset.fornecedor));
  });

  fornecedores.forEach(applyFornecedorLogo);
}

// Best-effort: looks up the supplier's domain by name via Clearbit's free
// Autocomplete API, then uses Google's favicon service to grab an icon for
// that domain — both public, no API key. Falls back to the 🏭 emoji when
// no match is found or either request fails. Results are cached in memory
// so switching back to this list doesn't re-fetch.
const resourcesLogoCache = new Map(); // fornecedor -> domain | null

async function resolveFornecedorDomain(fornecedor) {
  if (resourcesLogoCache.has(fornecedor)) return resourcesLogoCache.get(fornecedor);
  try {
    const res = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(fornecedor)}`);
    if (!res.ok) throw new Error('lookup failed');
    const matches = await res.json();
    const domain = matches?.[0]?.domain || null;
    resourcesLogoCache.set(fornecedor, domain);
    return domain;
  } catch {
    resourcesLogoCache.set(fornecedor, null);
    return null;
  }
}

async function applyFornecedorLogo(fornecedor) {
  const domain = await resolveFornecedorDomain(fornecedor);
  if (!domain) return;

  // The icon element may have been re-rendered (e.g. list re-sorted) by
  // the time this resolves — always re-query rather than holding a stale ref.
  const icon = document.querySelector(`.resources-supplier-row__icon[data-icon-for="${CSS.escape(fornecedor)}"]`);
  if (!icon) return;

  const img = new Image();
  img.className = 'resources-supplier-row__logo';
  img.alt = '';
  img.src = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
  img.onload = () => icon.replaceChildren(img);
  // onerror: leave the emoji fallback in place.
}

function renderFornecedorDocs(fornecedor) {
  const header = document.getElementById('resources-header');
  const list = document.getElementById('resources-list');
  if (!header || !list) return;

  header.innerHTML = `
    <button class="resources-back-btn" id="resources-back-btn" aria-label="Voltar">‹ Fornecedores</button>
    <h2 class="resources-view__title">${resEsc(fornecedor)}</h2>
  `;
  document.getElementById('resources-back-btn').addEventListener('click', renderFornecedoresList);

  const docs = resourcesGroups.get(fornecedor) || [];

  list.innerHTML = docs.map(item => `
    <button class="resources-row" data-url="${resEsc(item.url)}" data-nome="${resEsc(item.nome)}">
      <span class="resources-row__icon">📄</span>
      <span class="resources-row__main">
        <span class="resources-row__nome">${resEsc(item.nome)}</span>
        ${item.tipo || item.atualizado ? `
          <span class="resources-row__meta">
            ${item.tipo ? resEsc(item.tipo) : ''}${item.tipo && item.atualizado ? ' · ' : ''}${item.atualizado ? resEsc(item.atualizado) : ''}
          </span>` : ''}
      </span>
    </button>
  `).join('');

  list.querySelectorAll('.resources-row').forEach(btn => {
    btn.addEventListener('click', () => openResourceViewer(btn.dataset.url, btn.dataset.nome));
  });
}

// Opens the PDF in an in-app iframe overlay rather than navigating out
// to drive.google.com — on mobile, top-level navigation to a Drive link
// gets intercepted by the Drive app and forces a Google sign-in prompt.
// An iframe embed never triggers that handoff, and since Google serves
// the bytes directly (not through our own API), there's no file-size
// limit either.
function openResourceViewer(url, nome) {
  const root = document.getElementById('recursos-panel');
  if (!root) return;

  const overlay = document.createElement('div');
  overlay.className = 'resources-viewer';
  overlay.innerHTML = `
    <div class="resources-viewer__header">
      <span class="resources-viewer__title">${resEsc(nome)}</span>
      <button class="resources-viewer__close" aria-label="Fechar">✕</button>
    </div>
    <iframe class="resources-viewer__frame" src="${resEsc(url)}" allow="autoplay"></iframe>
  `;
  overlay.querySelector('.resources-viewer__close').addEventListener('click', () => overlay.remove());
  root.appendChild(overlay);
}
