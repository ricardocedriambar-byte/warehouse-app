// doors.js — Ficha de Encomenda de Portas
//
// Embedded inside "Nova Encomenda" as the "Portas" order type (not a
// standalone tab). Model: "tipos de porta" (spec × quantity). Guarnição/
// bite chosen per type. Dimensions read as ALTURA×LARGURA×ESPESSURA,
// matching the paper convention. On submit, the aggregated BOM becomes
// the order's line items (with synthetic SKUs, no stock impact — see
// lib/orders.js), and the full structured spec is saved as JSON on the
// order (doorsData) so the printable ficha can be regenerated later from
// the order's own detail screen.

let dpTypes = [];      // [{ id, qty, expanded, tipo, altura, largura, espessura, gLargo, gFino, vidro, biteStock, abertura, fechadura, obs }]
let dpTypeSeq = 0;
let dpMaterials = [];  // material/finish names, from the MateriaisPortas sheet tab
let dpMounted = false;

// Clears all door-type state — called each time "Nova Encomenda" opens,
// so a previous Portas order's data never bleeds into a new one.
function resetDoorsBuilder() {
  dpTypes = [];
  dpTypeSeq = 0;
  dpMounted = false;
}

// Mounts the builder UI into `container` (a div living inside the
// Nova Encomenda form). Safe to call multiple times if the person
// toggles the Tipo switch back and forth — state is preserved across
// re-mounts within the same order-create session.
function renderDoorsBuilder(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="doors-embed">
      <div class="doors-summary" id="dp-summary"></div>

      <div class="doors-row2">
        <input type="text" id="dp-obra" class="order-field" placeholder="Obra / referência (opcional)">
        <input type="date" id="dp-data" class="order-field">
      </div>

      <div class="section-label" style="margin-top:16px">Tipos de porta</div>
      <div id="dp-types-container"></div>
      <button type="button" id="dp-add-type" class="btn-ghost doors-full-btn">+ Adicionar tipo de porta</button>

      <div class="section-label" style="margin-top:16px">Observações gerais</div>
      <textarea id="dp-obs-gerais" class="order-field doors-textarea" placeholder="Mecanizar blocos, envernizar, prazo, etc."></textarea>

      <div class="section-label" style="margin-top:16px">Pré-visualização</div>
      <div class="doors-doc" id="dp-document">
        <div class="doors-doc__header">
          <img class="doors-doc__logo" src="/icons/icon-512.png" alt="Cedriambar">
          <div class="doors-doc__heading">
            <h2>Ficha de Encomenda</h2>
            <div class="doors-doc__sub" id="dp-out-sub"></div>
          </div>
          <div class="doors-doc__date" id="dp-out-date">—</div>
        </div>

        <div class="doors-doc__section-title">Materiais a separar</div>
        <table class="doors-doc__bom" id="dp-out-bom"></table>

        <div class="doors-doc__section-title">Detalhe por tipo</div>
        <table class="doors-doc__table">
          <thead>
            <tr>
              <th>Qtd</th><th>Medida</th><th>Tipo</th>
              <th>Abertura</th><th>Vidro</th><th>Fechad. / Obs.</th>
            </tr>
          </thead>
          <tbody id="dp-out-doors"></tbody>
        </table>

        <div class="doors-doc__obs-label">Observações gerais</div>
        <div class="doors-doc__obs-value" id="dp-out-obs">&nbsp;</div>
      </div>
    </div>
  `;

  ['dp-obra','dp-data','dp-obs-gerais'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', renderDoorsAll);
    el.addEventListener('change', renderDoorsAll);
  });

  document.getElementById('dp-add-type').addEventListener('click', () => addDoorType(true));

  if (!dpMounted) {
    document.getElementById('dp-data').valueAsDate = new Date();
    if (dpTypes.length === 0) addDoorType(true);
    dpMounted = true;
  } else {
    renderTypesList();
  }
  renderDoorsAll();
  loadDoorMaterials();
}

async function loadDoorMaterials() {
  try {
    const res = await fetch('/api/door-materials');
    const data = await res.json();
    dpMaterials = data.materials || [];
  } catch (err) {
    console.error('Falha ao carregar materiais', err);
    dpMaterials = [];
  }
  renderTypesList();
}

function addDoorType(expanded) {
  dpTypeSeq++;
  dpTypes.push({
    id: dpTypeSeq, qty: 1, expanded: !!expanded, tipo: 'simples',
    material: '',
    altura: '', largura: '', espessura: '',
    gLargo: 15, gFino: 10,
    vidro: false, biteStock: '1830',
    abertura: '', fechadura: '', obs: ''
  });
  renderTypesList();
  renderDoorsAll();
}

function dpSummaryText(t) {
  const tipoLabel = t.tipo === 'dupla' ? 'Dupla' : (t.tipo === 'passagem' ? 'Passagem' : 'Simples');
  const parts = [tipoLabel, dpMedida(t) || 'sem medidas'];
  if (t.material) parts.push(t.material);
  if (t.vidro) parts.push('vidro');
  return parts.join(' · ');
}

function dpMedida(t) {
  return [t.altura, t.largura, t.espessura].filter(Boolean).join('X');
}

function renderTypesList() {
  const container = document.getElementById('dp-types-container');
  if (!container) return;
  container.innerHTML = dpTypes.map(t => `
    <div class="doors-type" data-id="${t.id}">
      <div class="doors-type__row">
        <div class="doors-stepper">
          <button type="button" class="doors-stepper__btn" data-act="dec">−</button>
          <span class="doors-stepper__val">${t.qty}</span>
          <button type="button" class="doors-stepper__btn" data-act="inc">+</button>
        </div>
        <div class="doors-type__summary" data-act="expand">${dpEsc(dpSummaryText(t))}</div>
        <button type="button" class="doors-type__del" data-act="del">✕</button>
      </div>
      <div class="doors-type__body" style="display:${t.expanded ? 'block' : 'none'};">
        <div class="doors-type__dims-label">Altura × Largura × Espessura (aduela)</div>
        <div class="doors-row3">
          <input type="number" class="order-field t-altura" placeholder="Altura mm" value="${t.altura}">
          <input type="number" class="order-field t-largura" placeholder="Largura mm" value="${t.largura}">
          <input type="number" class="order-field t-espessura" placeholder="Espessura mm" value="${t.espessura}">
        </div>

        <select class="order-field t-material">
          ${dpMaterials.length === 0
            ? `<option value="">A carregar materiais…</option>`
            : `<option value="">Selecionar material…</option>` +
              dpMaterials.map(f => `<option value="${dpEsc(f)}" ${t.material===f?'selected':''}>${dpEsc(f)}</option>`).join('')}
        </select>

        <div class="doors-tipo-toggle">
          <button type="button" data-val="simples" class="${t.tipo==='simples'?'active':''}">Simples</button>
          <button type="button" data-val="dupla" class="${t.tipo==='dupla'?'active':''}">Dupla</button>
          <button type="button" data-val="passagem" class="${t.tipo==='passagem'?'active':''}">Passagem</button>
        </div>

        <div class="doors-type__sub-label">Guarnição</div>
        <div class="doors-row2">
          <input type="number" class="order-field t-g-largo" placeholder="Perfil largo (mm)" value="${t.gLargo}">
          <input type="number" class="order-field t-g-fino" placeholder="Perfil fino (mm)" value="${t.gFino}">
        </div>

        <label class="doors-checkbox">
          <input type="checkbox" class="t-vidro" ${t.vidro?'checked':''}>
          <span>Tem vidro</span>
        </label>
        <select class="order-field t-bite-stock" style="display:${t.vidro?'block':'none'};">
          <option value="1830" ${t.biteStock==='1830'?'selected':''}>Bite stock 1830mm — 6 peças</option>
          <option value="2750" ${t.biteStock==='2750'?'selected':''}>Bite stock 2750mm — 4 peças</option>
        </select>

        <div class="doors-row2">
          <select class="order-field t-abertura">
            <option value="">Abertura —</option>
            <option value="Esquerda" ${t.abertura==='Esquerda'?'selected':''}>Esquerda</option>
            <option value="Direita" ${t.abertura==='Direita'?'selected':''}>Direita</option>
            <option value="Dupla" ${t.abertura==='Dupla'?'selected':''}>Dupla</option>
            <option value="Correr" ${t.abertura==='Correr'?'selected':''}>De correr</option>
          </select>
          <input type="text" class="order-field t-fechadura" placeholder="Fechadura" value="${dpEsc(t.fechadura)}">
        </div>
        <textarea class="order-field t-obs doors-textarea" placeholder="Observações">${dpEsc(t.obs)}</textarea>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.doors-type').forEach(el => {
    const id = Number(el.dataset.id);
    const t = dpTypes.find(x => x.id === id);

    el.querySelector('[data-act="dec"]').addEventListener('click', () => {
      t.qty = Math.max(1, t.qty - 1);
      renderTypesList(); renderDoorsAll();
    });
    el.querySelector('[data-act="inc"]').addEventListener('click', () => {
      t.qty += 1;
      renderTypesList(); renderDoorsAll();
    });
    el.querySelector('[data-act="del"]').addEventListener('click', () => {
      dpTypes = dpTypes.filter(x => x.id !== id);
      renderTypesList(); renderDoorsAll();
    });
    el.querySelector('[data-act="expand"]').addEventListener('click', () => {
      t.expanded = !t.expanded;
      renderTypesList();
    });

    const body = el.querySelector('.doors-type__body');
    if (!body) return;

    body.querySelector('.t-altura').addEventListener('input', e => { t.altura = e.target.value; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-largura').addEventListener('input', e => { t.largura = e.target.value; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-espessura').addEventListener('input', e => { t.espessura = e.target.value; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-material').addEventListener('change', e => { t.material = e.target.value; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-g-largo').addEventListener('input', e => { t.gLargo = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-g-fino').addEventListener('input', e => { t.gFino = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-bite-stock').addEventListener('change', e => { t.biteStock = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-vidro').addEventListener('change', e => {
      t.vidro = e.target.checked;
      body.querySelector('.t-bite-stock').style.display = t.vidro ? 'block' : 'none';
      syncSummary(el, t); renderDoorsAll();
    });
    body.querySelector('.t-abertura').addEventListener('change', e => { t.abertura = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-fechadura').addEventListener('input', e => { t.fechadura = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-obs').addEventListener('input', e => { t.obs = e.target.value; renderDoorsAll(); });

    const toggle = body.querySelector('.doors-tipo-toggle');
    toggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        t.tipo = btn.dataset.val;
        toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        syncSummary(el, t);
        renderDoorsAll();
      });
    });
  });
}

function syncSummary(el, t) {
  el.querySelector('.doors-type__summary').textContent = dpSummaryText(t);
}

function dpEsc(v) {
  return (v || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function dpFmtDate(iso) {
  if (!iso) return '—';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function dpFmtNum(n) {
  return (Math.round(n*100)/100).toString().replace('.', ',');
}

// Renders BOM rows as table rows, converting the leading spaces baked
// into indented (child) descriptions to &nbsp; for HTML — the underlying
// data keeps plain spaces (which the PDF export needs as literal
// whitespace), only the on-screen preview needs this conversion.
function dpBomRowsHtml(bomRows) {
  return bomRows.map(r => {
    const leadingSpaces = r.descricao.match(/^ */)[0].length;
    const escaped = dpEsc(r.descricao.trim());
    const indented = '&nbsp;'.repeat(leadingSpaces) + escaped;
    const qtyCell = r.indent ? '' : dpFmtNum(r.qty);
    return `<tr class="${r.indent ? 'doors-doc__bom-child' : 'doors-doc__bom-parent'}"><td class="doors-doc__qty">${qtyCell}</td><td>${indented}</td></tr>`;
  }).join('');
}

function dpCalcType(t) {
  const aduelaPecasUnit = t.tipo === 'dupla' ? 3 : 2.5;
  const guarnLargoUnit = 4; // laterais — sempre 4, independente do tipo
  const guarnFinoUnit = t.tipo === 'dupla' ? 2 : 1; // travessão (dupla) ou peça única (simples/passagem)
  const biteQtyUnit = t.vidro ? (t.biteStock === '1830' ? 6 : 4) : 0;
  return {
    aduelaPecas: aduelaPecasUnit * t.qty,
    guarnLargo: guarnLargoUnit * t.qty,
    guarnFino: guarnFinoUnit * t.qty,
    biteQty: biteQtyUnit * t.qty,
    leafCount: (t.tipo === 'dupla' ? 2 : 1) * t.qty,
  };
}

const ABERTURA_ABBREV = { Esquerda: 'ESQ', Direita: 'DIR', Dupla: 'DUPLA', Correr: 'CORR' };

// Per-type BOM — one "BLOCO" (or "PASSAGEM") parent line per door type,
// naming the finished piece the way it's called on the shop floor, with
// its own aduela/guarnição/bite components listed indented right beneath
// it. Unlike the old cross-type aggregation, materials are NOT merged
// across different door types anymore — each type's parts sit under its
// own heading, since that's how they get cut and assembled together.
// Child rows get a 4-space indent prefix baked into descricao — this
// carries through unchanged into the printed PDF (plain spaces) and is
// converted to non-breaking spaces only for the HTML preview.
// Returns [{ qty, descricao, indent }, ...].
function computeDoorsBom(types) {
  const rows = [];
  const INDENT = '        '; // 8 spaces — deeper than before, for clearer visual nesting

  types.forEach(t => {
    const c = dpCalcType(t);
    const mat = (t.material || '').toUpperCase();
    const vidroLabel = t.vidro ? 'VIDRO' : 'TAPADO';
    const aberturaLabel = ABERTURA_ABBREV[t.abertura] || '';
    const parentPrefix = t.tipo === 'passagem' ? 'PASSAGEM' : 'BLOCO';
    const parentParts = [parentPrefix, vidroLabel, mat, aberturaLabel].filter(Boolean);
    // Dimensions are NOT baked into the text — they go into their own
    // comprimento/largura/espessura fields (mapped altura→comprimento),
    // same as any normal catalog item, so they land in the Nota de
    // Encomenda's own Comp./Larg./Esp. columns instead of being read
    // out of a sentence.
    rows.push({
      qty: c.leafCount, descricao: parentParts.join(' '), indent: false,
      altura: t.altura || '', largura: t.largura || '', espessura: t.espessura || ''
    });

    // Component (child) rows: the piece count is folded into the text
    // itself ("— 6 pç") rather than shown in the Qtd. Ped. column, which
    // is reserved for the parent's own order quantity.
    const childRow = (qty, text) => rows.push({ qty, descricao: `${INDENT}${text} — ${dpFmtNum(qty)} pç`, indent: true });

    const aduelaQty = Math.round(c.aduelaPecas * 100) / 100;
    if (t.tipo === 'passagem') {
      childRow(aduelaQty, `Aduela de passagem${mat ? ' ' + mat : ''} ${t.espessura || '?'}MM`);
    } else {
      childRow(aduelaQty, `Aduela${mat ? ' ' + mat : ''} ${t.espessura || '?'}MM C/ REBAIXO`);
    }
    if (c.guarnLargo > 0) {
      childRow(Math.round(c.guarnLargo * 100) / 100, `Guarnição${mat ? ' ' + mat : ''} 2200X70X${t.gLargo || '15'}MM`);
    }
    if (c.guarnFino > 0) {
      childRow(Math.round(c.guarnFino * 100) / 100, `Guarnição${mat ? ' ' + mat : ''} 2200X70X${t.gFino || '10'}MM`);
    }
    if (c.biteQty > 0) {
      const stockLabel = t.biteStock === '1830' ? '1830X22X19MM' : '2750X19X22MM';
      childRow(Math.round(c.biteQty * 100) / 100, `Bite MDF ${stockLabel}`);
    }
  });

  return rows;
}

function renderDoorsAll() {
  renderDoorsSummaryBar();
  renderDoorsDocument();
}

function renderDoorsSummaryBar() {
  const bar = document.getElementById('dp-summary');
  if (!bar) return;

  let portas = 0, aduela = 0, guarnicao = 0, bite = 0;
  dpTypes.forEach(t => {
    const c = dpCalcType(t);
    if (t.tipo !== 'passagem') portas += c.leafCount;
    aduela += c.aduelaPecas;
    guarnicao += c.guarnLargo + c.guarnFino;
    bite += c.biteQty;
  });

  const chips = [`${portas} porta${portas===1?'':'s'}`];
  if (aduela > 0) chips.push(`${dpFmtNum(aduela)} aduelas`);
  if (guarnicao > 0) chips.push(`${dpFmtNum(guarnicao)} guarnições`);
  if (bite > 0) chips.push(`${dpFmtNum(bite)} bites`);

  bar.innerHTML = chips.map(c => `<span class="doors-summary__chip">${c}</span>`).join('');
}

function renderDoorsDocument() {
  const obraEl = document.getElementById('dp-obra');
  if (!obraEl) return;

  const obra = obraEl.value;
  const clientName = (typeof orderState !== 'undefined' && orderState.newOrderClient) ? orderState.newOrderClient.name : '';

  document.getElementById('dp-out-date').textContent = dpFmtDate(document.getElementById('dp-data').value);
  document.getElementById('dp-out-sub').textContent =
    [clientName, obra].filter(Boolean).join(' — ') || 'Especificação de portas para produção';
  document.getElementById('dp-out-obs').innerHTML = dpEsc(document.getElementById('dp-obs-gerais').value).replace(/\n/g,'<br>') || '&nbsp;';

  const doorsBody = document.getElementById('dp-out-doors');
  const bomBody = document.getElementById('dp-out-bom');

  if (dpTypes.length === 0) {
    doorsBody.innerHTML = `<tr><td colspan="6" class="doors-empty">Sem tipos de porta adicionados.</td></tr>`;
    bomBody.innerHTML = `<tr><td class="doors-empty">Sem dados.</td></tr>`;
    return;
  }

  doorsBody.innerHTML = dpTypes.map(t => {
    const tipoLabel = t.tipo === 'dupla' ? 'Dupla' : (t.tipo === 'passagem' ? 'Passagem' : 'Simples');
    return `
      <tr>
        <td>${t.qty}</td>
        <td>${dpMedida(t) ? dpMedida(t) + 'MM' : '—'}</td>
        <td>${tipoLabel}${t.material ? ' · ' + dpEsc(t.material) : ''}</td>
        <td>${dpEsc(t.abertura) || '—'}</td>
        <td>${t.vidro ? 'Sim' : '—'}</td>
        <td>${[dpEsc(t.fechadura), dpEsc(t.obs)].filter(Boolean).join(' · ') || '—'}</td>
      </tr>
    `;
  }).join('');

  const bomRows = computeDoorsBom(dpTypes);
  bomBody.innerHTML = dpBomRowsHtml(bomRows);
}

// Packages the current builder state into what createOrder() needs:
// order lines (the BOM, with synthetic SKUs so they never touch real
// inventory stock) plus the full structured spec for later reprinting.
function getDoorsOrderPayload() {
  const obra = document.getElementById('dp-obra')?.value || '';
  const dataFicha = document.getElementById('dp-data')?.value || '';
  const obsGerais = document.getElementById('dp-obs-gerais')?.value || '';
  const bomRows = computeDoorsBom(dpTypes);

  const lines = bomRows.map((r, i) => ({
    sku: `PORTA-${i + 1}`,
    descricao: r.descricao,
    qtyOrdered: r.qty,
    unidade: 'un',
    unitPrice: 0,
    comprimento: r.indent ? '' : (r.altura || ''),
    largura: r.indent ? '' : (r.largura || ''),
    espessura: r.indent ? '' : (r.espessura || ''),
    discountPct: 0
  }));

  const doorsData = {
    obra, dataFicha, obsGerais,
    types: dpTypes.map(t => ({ ...t })),
    bomRows
  };

  return { lines, doorsData };
}

function doorsHasContent() {
  return dpTypes.length > 0 && dpTypes.some(t => t.qty > 0);
}

// ═══════════════════════════════════════════════════════════
// SAVED ORDER VIEW — renders the read-only ficha for a Portas order
// that's already been submitted, from its stored doorsData JSON.
// ═══════════════════════════════════════════════════════════
function renderSavedDoorsDocument(container, order) {
  const d = order.doorsData;
  if (!container || !d) return;

  const bomRowsHtml = (d.bomRows && d.bomRows.length)
    ? dpBomRowsHtml(d.bomRows)
    : `<tr><td class="doors-empty">Sem dados.</td></tr>`;

  const typesHtml = (d.types || []).map(t => {
    const tipoLabel = t.tipo === 'dupla' ? 'Dupla' : (t.tipo === 'passagem' ? 'Passagem' : 'Simples');
    return `
      <tr>
        <td>${t.qty}</td>
        <td>${dpMedida(t) ? dpMedida(t) + 'MM' : '—'}</td>
        <td>${tipoLabel}${t.material ? ' · ' + dpEsc(t.material) : ''}</td>
        <td>${dpEsc(t.abertura) || '—'}</td>
        <td>${t.vidro ? 'Sim' : '—'}</td>
        <td>${[dpEsc(t.fechadura), dpEsc(t.obs)].filter(Boolean).join(' · ') || '—'}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="6" class="doors-empty">Sem tipos de porta.</td></tr>`;

  container.innerHTML = `
    <div class="doors-doc" id="dp-saved-document">
      <div class="doors-doc__header">
        <img class="doors-doc__logo" src="/icons/icon-512.png" alt="Cedriambar">
        <div class="doors-doc__heading">
          <h2>Ficha de Encomenda</h2>
          <div class="doors-doc__sub">${dpEsc([order.clientName, d.obra].filter(Boolean).join(' — ')) || 'Especificação de portas para produção'}</div>
        </div>
        <div class="doors-doc__date">${dpFmtDate(d.dataFicha)}</div>
      </div>

      <div class="doors-doc__section-title">Materiais a separar</div>
      <table class="doors-doc__bom">${bomRowsHtml}</table>

      <div class="doors-doc__section-title">Detalhe por tipo</div>
      <table class="doors-doc__table">
        <thead>
          <tr><th>Qtd</th><th>Medida</th><th>Tipo</th><th>Abertura</th><th>Vidro</th><th>Fechad. / Obs.</th></tr>
        </thead>
        <tbody>${typesHtml}</tbody>
      </table>

      <div class="doors-doc__obs-label">Observações gerais</div>
      <div class="doors-doc__obs-value">${d.obsGerais ? dpEsc(d.obsGerais).replace(/\n/g,'<br>') : '&nbsp;'}</div>
    </div>
  `;
}
