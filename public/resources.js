// resources.js — Recursos (tabelas de preços e catálogos de fornecedores)
//
// Read-only tab: the PDFs themselves live in Google Drive. This just
// lists them, grouped by fornecedor, sourced from the "Recursos" tab
// in Sheets. Vendedor-only — wired in app.js / hidden via applyRoleRestrictions().

let resourcesRendered = false;

async function renderResourcesPanel() {
  const root = document.getElementById('recursos-panel');
  if (!root) return;
  if (resourcesRendered) return;
  resourcesRendered = true;

  root.innerHTML = `
    <div class="resources-view">
      <div class="resources-view__header">
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
      list.innerHTML = `<div class="resources__empty">Ainda não há recursos. Adiciona linhas na aba "Recursos" da folha.</div>`;
      return;
    }

    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.fornecedor)) groups.set(item.fornecedor, []);
      groups.get(item.fornecedor).push(item);
    }

    const sortedFornecedores = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'pt'));

    list.innerHTML = sortedFornecedores.map(fornecedor => `
      <div class="resources__group">
        <div class="section-label">${resEsc(fornecedor)}</div>
        ${groups.get(fornecedor).map(item => `
          <a class="resources-row" href="${resEsc(item.url)}" target="_blank" rel="noopener">
            <span class="resources-row__icon">📄</span>
            <span class="resources-row__main">
              <span class="resources-row__nome">${resEsc(item.nome)}</span>
              ${item.tipo || item.atualizado ? `
                <span class="resources-row__meta">
                  ${item.tipo ? resEsc(item.tipo) : ''}${item.tipo && item.atualizado ? ' · ' : ''}${item.atualizado ? resEsc(item.atualizado) : ''}
                </span>` : ''}
            </span>
          </a>
        `).join('')}
      </div>
    `).join('');
  } catch (err) {
    console.error('Falha ao carregar recursos', err);
    list.innerHTML = `<div class="resources__empty" style="color:var(--danger)">Não foi possível carregar os recursos.</div>`;
  }
}
