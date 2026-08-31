// doors.js — Ficha de Encomenda de Portas (Cedriambar)
// Model: "tipos de porta" (spec × quantity). Guarnição/bite chosen per type.
// Dimensions read as ALTURA×LARGURA×ESPESSURA, matching the paper convention.
// Material is picked from the live inventory (familia), not free text.
// Print-only — nothing is saved to Sheets.

let doorsRendered = false;
let dpTypes = [];      // [{ id, qty, expanded, tipo, altura, largura, espessura, gLargo, gFino, vidro, biteStock, abertura, fechadura, obs }]
let dpTypeSeq = 0;
let dpMaterials = [];  // distinct familia values from inventory

async function renderDoorsPanel() {
  const root = document.getElementById('portas-panel');
  if (!root) return;
  if (doorsRendered) { renderDoorsAll(); return; }
  doorsRendered = true;

  root.innerHTML = `
    <div class="doors-view">
      <div class="doors-summary" id="dp-summary"></div>

      <div class="doors-view__header">
        <h2 class="doors-view__title">Ficha de Encomenda — Portas</h2>
      </div>

      <div class="order-create__section">
        <div class="doors-row2">
          <input type="text" id="dp-cliente" class="order-field" placeholder="Cliente / obra">
          <input type="date" id="dp-data" class="order-field">
        </div>
        <select id="dp-material" class="order-field">
          <option value="">A carregar materiais…</option>
        </select>
      </div>

      <div class="order-create__section">
        <div class="section-label">Tipos de porta</div>
        <div id="dp-types-container"></div>
        <button type="button" id="dp-add-type" class="btn-ghost doors-full-btn">+ Adicionar tipo de porta</button>
      </div>

      <div class="order-create__section">
        <div class="section-label">Observações gerais</div>
        <textarea id="dp-obs-gerais" class="order-field doors-textarea" placeholder="Mecanizar blocos, envernizar, prazo, etc."></textarea>
      </div>

      <button type="button" id="dp-print-btn" class="btn-primary doors-full-btn">Imprimir / Guardar PDF</button>

      <div class="order-create__section">
        <div class="section-label">Pré-visualização</div>
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
    </div>
  `;

  ['dp-cliente','dp-data','dp-material','dp-obs-gerais'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', renderDoorsAll);
    el.addEventListener('change', renderDoorsAll);
  });

  document.getElementById('dp-add-type').addEventListener('click', () => addDoorType(true));
  document.getElementById('dp-print-btn').addEventListener('click', () => window.print());

  document.getElementById('dp-data').valueAsDate = new Date();
  addDoorType(true);
  renderDoorsAll();
  loadDoorMaterials();
}

async function loadDoorMaterials() {
  const sel = document.getElementById('dp-material');
  try {
    const res = await fetch('/api/door-materials');
    const data = await res.json();
    dpMaterials = data.materials || [];
    sel.innerHTML = `<option value="">Selecionar material…</option>` +
      dpMaterials.map(f => `<option value="${dpEsc(f)}">${dpEsc(f)}</option>`).join('');
  } catch (err) {
    console.error('Falha ao carregar materiais', err);
    sel.innerHTML = `<option value="">Não foi possível carregar materiais</option>`;
  }
}

function addDoorType(expanded) {
  dpTypeSeq++;
  dpTypes.push({
    id: dpTypeSeq, qty: 1, expanded: !!expanded, tipo: 'simples',
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
  if (t.vidro) parts.push('vidro');
  return parts.join(' · ');
}

function dpMedida(t) {
  return [t.altura, t.largura, t.espessura].filter(Boolean).join('X');
}

function renderTypesList() {
  const container = document.getElementById('dp-types-container');
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
  const cliente = document.getElementById('dp-cliente').value;
  const material = document.getElementById('dp-material').value;

  document.getElementById('dp-out-date').textContent = dpFmtDate(document.getElementById('dp-data').value);
  document.getElementById('dp-out-sub').textContent = [cliente, material].filter(Boolean).join(' — ') || 'Especificação de portas para produção';
  document.getElementById('dp-out-obs').innerHTML = dpEsc(document.getElementById('dp-obs-gerais').value).replace(/\n/g,'<br>') || '&nbsp;';

  const doorsBody = document.getElementById('dp-out-doors');
  const bomBody = document.getElementById('dp-out-bom');

  if (dpTypes.length === 0) {
    doorsBody.innerHTML = `<tr><td colspan="6" class="doors-empty">Sem tipos de porta adicionados.</td></tr>`;
    bomBody.innerHTML = `<tr><td class="doors-empty">Sem dados.</td></tr>`;
    return;
  }

  const portaGroups = {};
  const aduelaGroups = {};
  const aduelaPassagemGroups = {};
  const guarnGroups = {}; // key: mm -> total peças (largo e fino fundem-se automaticamente quando a medida é igual)
  const biteGroups = {};  // key: stock -> total peças

  doorsBody.innerHTML = dpTypes.map(t => {
    const c = dpCalcType(t);

    if (t.tipo !== 'passagem') {
      const key = `${t.altura || '?'}x${t.largura || '?'}|${t.tipo}`;
      portaGroups[key] = (portaGroups[key] || 0) + c.leafCount;
    }

    const esKey = t.espessura || '?';
    if (t.tipo === 'passagem') {
      aduelaPassagemGroups[esKey] = (aduelaPassagemGroups[esKey] || 0) + c.aduelaPecas;
    } else {
      aduelaGroups[esKey] = (aduelaGroups[esKey] || 0) + c.aduelaPecas;
    }

    if (c.guarnLargo > 0) {
      const mm = t.gLargo || '15';
      guarnGroups[mm] = (guarnGroups[mm] || 0) + c.guarnLargo;
    }
    if (c.guarnFino > 0) {
      const mm = t.gFino || '10';
      guarnGroups[mm] = (guarnGroups[mm] || 0) + c.guarnFino;
    }
    if (c.biteQty > 0) {
      biteGroups[t.biteStock] = (biteGroups[t.biteStock] || 0) + c.biteQty;
    }

    const tipoLabel = t.tipo === 'dupla' ? 'Dupla' : (t.tipo === 'passagem' ? 'Passagem' : 'Simples');
    return `
      <tr>
        <td>${t.qty}</td>
        <td>${dpMedida(t) ? dpMedida(t) + 'MM' : '—'}</td>
        <td>${tipoLabel}</td>
        <td>${dpEsc(t.abertura) || '—'}</td>
        <td>${t.vidro ? 'Sim' : '—'}</td>
        <td>${[dpEsc(t.fechadura), dpEsc(t.obs)].filter(Boolean).join(' · ') || '—'}</td>
      </tr>
    `;
  }).join('');

  const bomRows = [];
  Object.keys(portaGroups).forEach(key => {
    const [dim] = key.split('|');
    const [alt, larg] = dim.split('x');
    bomRows.push([portaGroups[key], `PORTA${material ? ' ' + material.toUpperCase() : ''} ${alt}X${larg}MM`]);
  });
  Object.keys(aduelaGroups).sort((a,b)=>a-b).forEach(es => {
    bomRows.push([dpFmtNum(aduelaGroups[es]), `ADUELA${material ? ' ' + material.toUpperCase() : ''} ${es}MM C/ REBAIXO (peças)`]);
  });
  Object.keys(aduelaPassagemGroups).sort((a,b)=>a-b).forEach(es => {
    bomRows.push([dpFmtNum(aduelaPassagemGroups[es]), `ADUELA DE PASSAGEM${material ? ' ' + material.toUpperCase() : ''} ${es}MM (peças)`]);
  });
  Object.keys(guarnGroups).sort((a,b)=>a-b).forEach(mm => {
    bomRows.push([dpFmtNum(guarnGroups[mm]), `GUARNIÇÃO${material ? ' ' + material.toUpperCase() : ''} 2200X70X${mm}MM`]);
  });
  Object.keys(biteGroups).forEach(stock => {
    const stockLabel = stock === '1830' ? '1830X22X19MM' : '2750X19X22MM';
    bomRows.push([dpFmtNum(biteGroups[stock]), `BITE MDF${material ? ' ' + material.toUpperCase() : ''} ${stockLabel}`]);
  });

  bomBody.innerHTML = bomRows.map(r => `<tr><td class="doors-doc__qty">${r[0]}</td><td>${r[1]}</td></tr>`).join('');
}
