// doors.js — Ficha de Encomenda de Portas (Cedriambar)
// Standalone panel rendered inside the "Portas" tab. No backend calls —
// this is a print-only tool (nothing is saved to Sheets).

let doorsRendered = false;
let doorCardCount = 0;

function renderDoorsPanel() {
  const root = document.getElementById('portas-panel');
  if (!root) return;
  if (doorsRendered) return; // build once, keep state across tab switches
  doorsRendered = true;

  root.innerHTML = `
    <div class="doors-view">
      <div class="doors-view__header">
        <h2 class="doors-view__title">Ficha de Encomenda — Portas</h2>
        <p class="doors-view__subtitle">Calcula automaticamente aduelas, guarnições e bites</p>
      </div>

      <div class="order-create__section">
        <div class="section-label">Dados da obra</div>
        <input type="text" id="dp-cliente" class="order-field" placeholder="Cliente / referência da obra">
        <input type="date" id="dp-data" class="order-field">
        <input type="text" id="dp-material" class="order-field" placeholder="Material / acabamento (ex: CPL BRANCO)">
        <div class="doors-row2">
          <input type="number" id="dp-g-largo" class="order-field" placeholder="Guarnição largo (mm)" value="15">
          <input type="number" id="dp-g-fino" class="order-field" placeholder="Guarnição fino (mm)" value="10">
        </div>
        <select id="dp-bite-stock" class="order-field">
          <option value="1830">Bite stock 1830mm — 6 peças/porta com vidro</option>
          <option value="2750">Bite stock 2750mm — 4 peças/porta com vidro</option>
        </select>
      </div>

      <div class="order-create__section">
        <div class="section-label">Portas</div>
        <div id="dp-doors-container"></div>
        <button type="button" id="dp-add-door" class="btn-ghost doors-full-btn">+ Adicionar porta</button>
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

          <div class="doors-doc__section-title">Detalhe por porta</div>
          <table class="doors-doc__table">
            <thead>
              <tr>
                <th>Nº</th><th>Local</th><th>Larg.</th><th>Alt.</th><th>Aduela</th>
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

  // wire global fields
  ['dp-cliente','dp-data','dp-material','dp-g-largo','dp-g-fino','dp-bite-stock','dp-obs-gerais'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', renderDoorsDocument);
    el.addEventListener('change', renderDoorsDocument);
  });

  document.getElementById('dp-add-door').addEventListener('click', addDoorCard);
  document.getElementById('dp-print-btn').addEventListener('click', () => window.print());

  document.getElementById('dp-data').valueAsDate = new Date();
  addDoorCard();
  renderDoorsDocument();
}

function addDoorCard() {
  doorCardCount++;
  const id = doorCardCount;
  const container = document.getElementById('dp-doors-container');
  const card = document.createElement('div');
  card.className = 'doors-card';
  card.dataset.tipo = 'simples';
  card.innerHTML = `
    <div class="doors-card__title">
      <span>Porta ${id}</span>
      <button type="button" class="doors-card__remove">✕ remover</button>
    </div>

    <input type="text" class="order-field d-local" placeholder="Local / designação (ex: Quarto 1)">

    <div class="doors-row3">
      <input type="number" class="order-field d-largura" placeholder="Largura mm">
      <input type="number" class="order-field d-altura" placeholder="Altura mm">
      <input type="number" class="order-field d-espessura" placeholder="Aduela mm">
    </div>

    <div class="doors-tipo-toggle">
      <button type="button" data-val="simples" class="active">Simples</button>
      <button type="button" data-val="dupla">Dupla</button>
      <button type="button" data-val="passagem">Passagem</button>
    </div>

    <select class="order-field d-travessao doors-travessao-row" style="display:none;">
      <option value="fino">Travessão: perfil fino</option>
      <option value="largo">Travessão: perfil largo</option>
    </select>

    <label class="doors-checkbox">
      <input type="checkbox" class="d-vidro">
      <span>Tem vidro</span>
    </label>

    <div class="doors-row2">
      <select class="order-field d-abertura">
        <option value="">Abertura —</option>
        <option value="Esquerda">Esquerda</option>
        <option value="Direita">Direita</option>
        <option value="Dupla">Dupla</option>
        <option value="Correr">De correr</option>
      </select>
      <input type="text" class="order-field d-fechadura" placeholder="Fechadura">
    </div>

    <textarea class="order-field d-obs doors-textarea" placeholder="Observações desta porta"></textarea>
  `;

  card.querySelector('.doors-card__remove').addEventListener('click', () => {
    card.remove();
    renderDoorsDocument();
  });

  const toggle = card.querySelector('.doors-tipo-toggle');
  toggle.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      card.dataset.tipo = btn.dataset.val;
      card.querySelector('.doors-travessao-row').style.display = (btn.dataset.val === 'dupla') ? 'block' : 'none';
      renderDoorsDocument();
    });
  });

  card.querySelectorAll('input, select, textarea').forEach(el => {
    el.addEventListener('input', renderDoorsDocument);
    el.addEventListener('change', renderDoorsDocument);
  });

  container.appendChild(card);
  renderDoorsDocument();
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

function dpReadDoor(card) {
  return {
    tipo: card.dataset.tipo,
    local: card.querySelector('.d-local').value,
    largura: card.querySelector('.d-largura').value,
    altura: card.querySelector('.d-altura').value,
    espessura: card.querySelector('.d-espessura').value,
    travessao: card.querySelector('.d-travessao').value,
    vidro: card.querySelector('.d-vidro').checked,
    abertura: card.querySelector('.d-abertura').value,
    fechadura: card.querySelector('.d-fechadura').value,
    obs: card.querySelector('.d-obs').value,
  };
}

function dpCalcDoor(d, biteStock) {
  const aduelaPecas = d.tipo === 'dupla' ? 3 : 2.5;
  let guarnLargo = 4;
  let guarnFino = 0;
  if (d.tipo === 'dupla') {
    if (d.travessao === 'largo') guarnLargo += 2;
    else guarnFino += 2;
  } else {
    guarnFino += 1;
  }
  const biteQty = d.vidro ? (biteStock === '1830' ? 6 : 4) : 0;
  return { aduelaPecas, guarnLargo, guarnFino, biteQty };
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

  const cards = Array.from(document.querySelectorAll('#dp-doors-container .doors-card'));
  const doorsBody = document.getElementById('dp-out-doors');
  const bomBody = document.getElementById('dp-out-bom');

  if (cards.length === 0) {
    doorsBody.innerHTML = `<tr><td colspan="9" class="doors-empty">Sem portas adicionadas.</td></tr>`;
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

  doorsBody.innerHTML = cards.map((card, i) => {
    const d = dpReadDoor(card);
    const calc = dpCalcDoor(d, biteStock);

    if (d.tipo !== 'passagem') {
      const leafCount = d.tipo === 'dupla' ? 2 : 1;
      const key = `${d.largura || '?'}x${d.altura || '?'}|${d.tipo}`;
      portaGroups[key] = (portaGroups[key] || 0) + leafCount;
    }

    const esKey = d.espessura || '?';
    if (d.tipo === 'passagem') {
      aduelaPassagemGroups[esKey] = (aduelaPassagemGroups[esKey] || 0) + calc.aduelaPecas;
    } else {
      aduelaGroups[esKey] = (aduelaGroups[esKey] || 0) + calc.aduelaPecas;
    }

    guarnLargoTotal += calc.guarnLargo;
    guarnFinoTotal += calc.guarnFino;
    biteTotal += calc.biteQty;
    if (d.vidro) anyVidro = true;

    const tipoLabel = d.tipo === 'dupla' ? 'Dupla' : (d.tipo === 'passagem' ? 'Passagem' : 'Simples');
    return `
      <tr>
        <td>${i+1}</td>
        <td>${dpEsc(d.local) || '—'}</td>
        <td>${d.largura ? d.largura+'mm' : '—'}</td>
        <td>${d.altura ? d.altura+'mm' : '—'}</td>
        <td>${d.espessura ? d.espessura+'mm' : '—'}</td>
        <td>${tipoLabel}</td>
        <td>${dpEsc(d.abertura) || '—'}</td>
        <td>${d.vidro ? 'Sim' : '—'}</td>
        <td>${[dpEsc(d.fechadura), dpEsc(d.obs)].filter(Boolean).join(' · ') || '—'}</td>
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
