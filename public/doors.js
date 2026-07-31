// doors.js — Ficha de Encomenda de Portas (Cedriambar)
// Model: the user defines "tipos de porta" (a spec) and a quantity for each,
// instead of one entry per physical door. Totals are always visible (sticky
// bar) while adding/editing types. Print-only — nothing is saved to Sheets.

let doorsRendered = false;
let dpTypes = [];      // [{ id, qty, expanded, tipo, local, largura, altura, espessura, travessao, vidro, abertura, fechadura, obs }]
let dpTypeSeq = 0;

function renderDoorsPanel() {
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
        <div class="doors-row3">
          <input type="text" id="dp-cliente" class="order-field" placeholder="Cliente / obra">
          <input type="date" id="dp-data" class="order-field">
        </div>
        <input type="text" id="dp-material" class="order-field" placeholder="Material / acabamento (ex: CPL BRANCO)">

        <button type="button" id="dp-adv-toggle" class="doors-adv-toggle">Mais definições ▾</button>
        <div id="dp-adv-body" class="doors-adv-body" style="display:none;">
          <div class="doors-row2">
            <input type="number" id="dp-g-largo" class="order-field" placeholder="Guarnição largo (mm)" value="15">
            <input type="number" id="dp-g-fino" class="order-field" placeholder="Guarnição fino (mm)" value="10">
          </div>
          <select id="dp-bite-stock" class="order-field">
            <option value="1830">Bite stock 1830mm — 6 peças/porta com vidro</option>
            <option value="2750">Bite stock 2750mm — 4 peças/porta com vidro</option>
          </select>
        </div>
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
            <div>
              <h2>Ficha de Encomenda</h2>
              <div class="doors-doc__sub" id="dp-out-sub">Especificação de portas para produção</div>
            </div>
            <div class="doors-doc__date" id="dp-out-date">—</div>
          </div>

          <div class="doors-doc__section-title">Materiais a separar</div>
          <table class="doors-doc__bom" id="dp-out-bom"></table>

          <div class="doors-doc__section-title">Detalhe por tipo</div>
          <table class="doors-doc__table">
            <thead>
              <tr>
                <th>Qtd</th><th>Local</th><th>Larg.</th><th>Alt.</th><th>Aduela</th>
                <th>Tipo</th><th>Abertura</th><th>Vidro</th><th>Fechad. / Obs.</th>
              </tr>
            </thead>
            <tbody id="dp-out-doors"></tbody>
          </table>

          <div class="doors-doc__obs-label">Observações gerais</div>
          <div class="doors-doc__obs-value" id="dp-out-obs">&nbsp;</div>

          <div class="doors-doc__sign">
            <div class="doors-doc__sig"><div class="doors-doc__sig-line"></div><span>Cliente</span></div>
            <div class="doors-doc__sig"><div class="doors-doc__sig-line"></div><span>Marceneiro</span></div>
          </div>
        </div>
      </div>
    </div>
  `;

  ['dp-cliente','dp-data','dp-material','dp-g-largo','dp-g-fino','dp-bite-stock','dp-obs-gerais'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', renderDoorsAll);
    el.addEventListener('change', renderDoorsAll);
  });

  document.getElementById('dp-adv-toggle').addEventListener('click', () => {
    const body = document.getElementById('dp-adv-body');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    document.getElementById('dp-adv-toggle').textContent = open ? 'Mais definições ▾' : 'Mais definições ▴';
  });

  document.getElementById('dp-add-type').addEventListener('click', () => addDoorType(true));
  document.getElementById('dp-print-btn').addEventListener('click', () => window.print());

  document.getElementById('dp-data').valueAsDate = new Date();
  addDoorType(true);
  renderDoorsAll();
}

function addDoorType(expanded) {
  dpTypeSeq++;
  dpTypes.push({
    id: dpTypeSeq, qty: 1, expanded: !!expanded, tipo: 'simples',
    local: '', largura: '', altura: '', espessura: '', travessao: 'fino',
    vidro: false, abertura: '', fechadura: '', obs: ''
  });
  renderTypesList();
  renderDoorsAll();
}

function dpSummaryText(t) {
  const tipoLabel = t.tipo === 'dupla' ? 'Dupla' : (t.tipo === 'passagem' ? 'Passagem' : 'Simples');
  const dims = (t.largura && t.altura) ? `${t.largura}×${t.altura}mm` : 'sem medidas';
  const parts = [t.local || tipoLabel, dims];
  if (t.espessura) parts.push(`aduela ${t.espessura}mm`);
  if (t.vidro) parts.push('vidro');
  return parts.join(' · ');
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
        <input type="text" class="order-field t-local" placeholder="Local / designação (opcional)" value="${dpEsc(t.local)}">
        <div class="doors-row3">
          <input type="number" class="order-field t-largura" placeholder="Largura mm" value="${t.largura}">
          <input type="number" class="order-field t-altura" placeholder="Altura mm" value="${t.altura}">
          <input type="number" class="order-field t-espessura" placeholder="Aduela mm" value="${t.espessura}">
        </div>
        <div class="doors-tipo-toggle">
          <button type="button" data-val="simples" class="${t.tipo==='simples'?'active':''}">Simples</button>
          <button type="button" data-val="dupla" class="${t.tipo==='dupla'?'active':''}">Dupla</button>
          <button type="button" data-val="passagem" class="${t.tipo==='passagem'?'active':''}">Passagem</button>
        </div>
        <select class="order-field t-travessao" style="display:${t.tipo==='dupla'?'block':'none'};">
          <option value="fino" ${t.travessao==='fino'?'selected':''}>Travessão: perfil fino</option>
          <option value="largo" ${t.travessao==='largo'?'selected':''}>Travessão: perfil largo</option>
        </select>
        <label class="doors-checkbox">
          <input type="checkbox" class="t-vidro" ${t.vidro?'checked':''}>
          <span>Tem vidro</span>
        </label>
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

    body.querySelector('.t-local').addEventListener('input', e => { t.local = e.target.value; syncSummary(el, t); });
    body.querySelector('.t-largura').addEventListener('input', e => { t.largura = e.target.value; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-altura').addEventListener('input', e => { t.altura = e.target.value; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-espessura').addEventListener('input', e => { t.espessura = e.target.value; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-travessao').addEventListener('change', e => { t.travessao = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-vidro').addEventListener('change', e => { t.vidro = e.target.checked; syncSummary(el, t); renderDoorsAll(); });
    body.querySelector('.t-abertura').addEventListener('change', e => { t.abertura = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-fechadura').addEventListener('input', e => { t.fechadura = e.target.value; renderDoorsAll(); });
    body.querySelector('.t-obs').addEventListener('input', e => { t.obs = e.target.value; renderDoorsAll(); });

    const toggle = body.querySelector('.doors-tipo-toggle');
    toggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        t.tipo = btn.dataset.val;
        body.querySelector('.t-travessao').style.display = (t.tipo === 'dupla') ? 'block' : 'none';
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

function dpCalcType(t, biteStock) {
  const aduelaPecasUnit = t.tipo === 'dupla' ? 3 : 2.5;
  let guarnLargoUnit = 4;
  let guarnFinoUnit = 0;
  if (t.tipo === 'dupla') {
    if (t.travessao === 'largo') guarnLargoUnit += 2;
    else guarnFinoUnit += 2;
  } else {
    guarnFinoUnit += 1;
  }
  const biteQtyUnit = t.vidro ? (biteStock === '1830' ? 6 : 4) : 0;
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
  const biteStock = document.getElementById('dp-bite-stock')?.value || '1830';

  let portas = 0, aduela = 0, guarnicao = 0, bite = 0;
  dpTypes.forEach(t => {
    const c = dpCalcType(t, biteStock);
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
  const gLargoMM = document.getElementById('dp-g-largo').value || '15';
  const gFinoMM = document.getElementById('dp-g-fino').value || '10';
  const biteStock = document.getElementById('dp-bite-stock').value;

  document.getElementById('dp-out-date').textContent = dpFmtDate(document.getElementById('dp-data').value);
  document.getElementById('dp-out-sub').textContent = [cliente, material].filter(Boolean).join(' — ') || 'Especificação de portas para produção';
  document.getElementById('dp-out-obs').innerHTML = dpEsc(document.getElementById('dp-obs-gerais').value).replace(/\n/g,'<br>') || '&nbsp;';

  const doorsBody = document.getElementById('dp-out-doors');
  const bomBody = document.getElementById('dp-out-bom');

  if (dpTypes.length === 0) {
    doorsBody.innerHTML = `<tr><td colspan="9" class="doors-empty">Sem tipos de porta adicionados.</td></tr>`;
    bomBody.innerHTML = `<tr><td class="doors-empty">Sem dados.</td></tr>`;
    return;
  }

  const portaGroups = {};
  const aduelaGroups = {};
  const aduelaPassagemGroups = {};
  let guarnLargoTotal = 0;
  let guarnFinoTotal = 0;
  let biteTotal = 0;
  let anyVidro = false;

  doorsBody.innerHTML = dpTypes.map(t => {
    const c = dpCalcType(t, biteStock);

    if (t.tipo !== 'passagem') {
      const key = `${t.largura || '?'}x${t.altura || '?'}|${t.tipo}`;
      portaGroups[key] = (portaGroups[key] || 0) + c.leafCount;
    }

    const esKey = t.espessura || '?';
    if (t.tipo === 'passagem') {
      aduelaPassagemGroups[esKey] = (aduelaPassagemGroups[esKey] || 0) + c.aduelaPecas;
    } else {
      aduelaGroups[esKey] = (aduelaGroups[esKey] || 0) + c.aduelaPecas;
    }

    guarnLargoTotal += c.guarnLargo;
    guarnFinoTotal += c.guarnFino;
    biteTotal += c.biteQty;
    if (t.vidro) anyVidro = true;

    const tipoLabel = t.tipo === 'dupla' ? 'Dupla' : (t.tipo === 'passagem' ? 'Passagem' : 'Simples');
    return `
      <tr>
        <td>${t.qty}</td>
        <td>${dpEsc(t.local) || '—'}</td>
        <td>${t.largura ? t.largura+'mm' : '—'}</td>
        <td>${t.altura ? t.altura+'mm' : '—'}</td>
        <td>${t.espessura ? t.espessura+'mm' : '—'}</td>
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
    const [larg, alt] = dim.split('x');
    bomRows.push([portaGroups[key], `PORTA${material ? ' ' + material.toUpperCase() : ''} ${larg}X${alt}MM`]);
  });
  Object.keys(aduelaGroups).sort((a,b)=>a-b).forEach(es => {
    bomRows.push([dpFmtNum(aduelaGroups[es]), `ADUELA${material ? ' ' + material.toUpperCase() : ''} ${es}MM C/ REBAIXO (peças)`]);
  });
  Object.keys(aduelaPassagemGroups).sort((a,b)=>a-b).forEach(es => {
    bomRows.push([dpFmtNum(aduelaPassagemGroups[es]), `ADUELA DE PASSAGEM${material ? ' ' + material.toUpperCase() : ''} ${es}MM (peças)`]);
  });
  if (guarnLargoTotal > 0) bomRows.push([dpFmtNum(guarnLargoTotal), `GUARNIÇÃO${material ? ' ' + material.toUpperCase() : ''} 2200X70X${gLargoMM}MM`]);
  if (guarnFinoTotal > 0) bomRows.push([dpFmtNum(guarnFinoTotal), `GUARNIÇÃO${material ? ' ' + material.toUpperCase() : ''} 2200X70X${gFinoMM}MM`]);
  if (anyVidro && biteTotal > 0) {
    const stockLabel = biteStock === '1830' ? '1830X22X19MM' : '2750X19X22MM';
    bomRows.push([dpFmtNum(biteTotal), `BITE MDF${material ? ' ' + material.toUpperCase() : ''} ${stockLabel}`]);
  }

  bomBody.innerHTML = bomRows.map(r => `<tr><td class="doors-doc__qty">${r[0]}</td><td>${r[1]}</td></tr>`).join('');
}
