const $ = (id) => document.getElementById(id);
const apiRoot = new URL('../api/', window.location.href);
let session = null;
let origins = [];
let cardsPage = 1;
let scannedPage = 1;
let originsPage = 1;
let partnersPage = 1;
let usersPage = 1;
let issuedTokens = [];
let currentCardsList = [];
let currentReportData = null;
let selectedPartner = null;
let cameraStream = null;
let scanActive = false;
let scanBusy = false;
let lastFrame = 0;
let detectorSupported = 'BarcodeDetector' in window;
let scannedInterval = null;
let selectedCardTokens = new Set();

function updateBatchToolbar() {
  const toolbar = $('cardsBatchToolbar');
  const countEl = $('selectedCardsCount');
  const selectAll = $('selectAllCards');
  const count = selectedCardTokens.size;

  if (countEl) countEl.textContent = count;
  if (toolbar) toolbar.style.display = count > 0 ? 'flex' : 'none';

  if (selectAll && currentCardsList.length > 0) {
    const pageTokens = currentCardsList.map((c) => c.token);
    const selectedOnPage = pageTokens.filter((t) => selectedCardTokens.has(t)).length;
    if (selectedOnPage === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    } else if (selectedOnPage === pageTokens.length) {
      selectAll.checked = true;
      selectAll.indeterminate = false;
    } else {
      selectAll.checked = false;
      selectAll.indeterminate = true;
    }
  }
}

function normalizeStr(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function formatDateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function node(tag, className = '', text = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  result.textContent = text;
  return result;
}

function notice(message, kind = '') {
  $('notice').textContent = message;
  $('notice').className = `message ${kind}`;
}

async function api(path, {method = 'GET', body} = {}) {
  const headers = {'Accept': 'application/json'};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && session?.csrf_token) headers['X-CSRF-Token'] = session.csrf_token;
  const response = await fetch(new URL(path, apiRoot), {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = 'Não foi possível concluir a operação.';
    try { detail = (await response.json()).detail || detail; } catch (_) { /* keep default */ }
    if (response.status === 401 && path !== 'login') showLoggedOut();
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showLoggedOut() {
  stopCamera();
  session = null;
  origins = [];
  selectedCardTokens.clear();
  $('originSearch').value = '';
  $('userForm').reset();
  $('workspace').hidden = true;
  $('account').hidden = true;
  $('loginPanel').hidden = false;
}

async function showLoggedIn(data) {
  session = data;
  $('loginPanel').hidden = true;
  $('workspace').hidden = false;
  $('account').hidden = false;
  $('accountName').textContent = `${data.username} · ${data.role === 'admin' ? 'admin' : 'operador'}`;
  document.querySelectorAll('.tab.admin-only, form.admin-only').forEach((element) => {
    element.hidden = data.role !== 'admin';
  });
  $('issueOperatorNote').hidden = data.role === 'admin';
  switchTab('scan');
  const loads = await Promise.allSettled([refreshOrigins(), refreshCards(), refreshScannedCards()]);
  for (const result of loads) {
    if (result.status === 'rejected') notice(result.reason.message, 'error');
  }
}

function switchTab(name) {
  if (scannedInterval) {
    clearInterval(scannedInterval);
    scannedInterval = null;
  }
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  for (const section of document.querySelectorAll('.tab-panel')) {
    section.hidden = section.id !== `${name}Tab`;
  }
  if (name !== 'scan') stopCamera();
  if (name === 'issue') refreshOriginChoices().catch((error) => notice(error.message, 'error'));
  if (name === 'cards') refreshCards().catch((error) => notice(error.message, 'error'));
  if (name === 'scanned') {
    scannedPage = 1;
    refreshScannedCards().catch((error) => notice(error.message, 'error'));
    scannedInterval = setInterval(() => {
      if (!$('scannedTab').hidden) {
        refreshScannedCards().catch(() => {});
      }
    }, 15000);
  }
  if (name === 'reports') refreshReports().catch((error) => notice(error.message, 'error'));
  if (name === 'origins') refreshOrigins().catch((error) => notice(error.message, 'error'));
  if (name === 'partners') refreshPartners().catch((error) => notice(error.message, 'error'));
  if (name === 'users' && session?.role === 'admin') refreshUsers().catch((error) => notice(error.message, 'error'));
  notice('');
}

function renderPager(prefix, result) {
  const pageCount = Math.max(1, result.pages);
  $(`${prefix}Page`).textContent = `${result.total} registro(s) · página ${result.page} de ${pageCount}`;
  $(`${prefix}Prev`).disabled = result.page <= 1;
  $(`${prefix}Next`).disabled = result.page >= pageCount;
}

async function refreshUsers() {
  const result = await api(`users?page=${usersPage}&page_size=20`);
  const body = $('usersBody');
  body.replaceChildren();
  for (const user of result.items) {
    const row = node('tr');
    row.append(node('td', '', user.username),
      node('td', '', user.role === 'admin' ? 'Administrador' : 'Operador'),
      node('td', '', user.active ? 'Ativo' : 'Inativo'),
      node('td', '', formatDate(user.created_at)));
    body.append(row);
  }
  if (!result.items.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum usuário cadastrado.');
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
  }
  renderPager('users', result);
}

function renderOriginChoices() {
  const select = $('issueOrigin');
  const selected = select.value;
  const rawQuery = $('originSearch').value;
  const query = normalizeStr(rawQuery);
  const matches = origins.filter((o) => !query || normalizeStr(o.name).includes(query) || normalizeStr(o.category).includes(query));

  const placeholder = node('option', '', matches.length ? 'Selecione uma origem ou parceiro' : 'Nenhum local encontrado');
  placeholder.value = '';

  const registeredGroup = node('optgroup');
  registeredGroup.label = 'Origens cadastradas (Prontas para emissão)';

  const confirmedGroup = node('optgroup');
  confirmedGroup.label = 'Parceiros contratados (Prontos para emissão)';

  const prospectGroup = node('optgroup');
  prospectGroup.label = 'Demais estabelecimentos — requer contratação prévia';

  for (const origin of matches) {
    if (origin.source === 'origin') {
      const opt = node('option', '', `✓ ${origin.name} — ${origin.category}`);
      opt.value = origin.id;
      registeredGroup.append(opt);
    } else if (origin.status === 'parceiro') {
      const opt = node('option', '', `✓ ${origin.name} — ${categoryLabels[origin.category] || origin.category} · Contratado`);
      opt.value = origin.id;
      confirmedGroup.append(opt);
    } else {
      const opt = node('option', '', `${origin.name} — ${categoryLabels[origin.category] || origin.category} · ${partnerStatusLabels[origin.status] || 'Pendente'}`);
      opt.value = origin.id;
      prospectGroup.append(opt);
    }
  }

  select.replaceChildren(placeholder);
  if (registeredGroup.children.length) select.append(registeredGroup);
  if (confirmedGroup.children.length) select.append(confirmedGroup);
  if (prospectGroup.children.length) select.append(prospectGroup);

  if (selected && matches.some((o) => o.id === selected)) {
    select.value = selected;
  } else if (query && matches.length === 1) {
    select.value = matches[0].id;
  } else {
    select.value = '';
  }
  renderSelectedOrigin();
  renderQuickOriginPills();

  const totalContracted = origins.filter((o) => o.source === 'origin' || o.status === 'parceiro').length;
  $('originHelp').textContent = `${totalContracted} local(is) cadastrado(s)/contratado(s) prontos para emissão imediata.`;
}

function renderQuickOriginPills() {
  const container = $('quickOriginPills');
  const section = $('quickOriginSection');
  if (!container || !section) return;
  const readyOrigins = origins.filter((o) => o.source === 'origin' || o.status === 'parceiro');
  if (!readyOrigins.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  container.replaceChildren();
  for (const origin of readyOrigins) {
    const isSelected = $('issueOrigin').value === origin.id;
    const pill = node('button', isSelected ? 'primary' : '', `📍 ${origin.name}`);
    pill.type = 'button';
    pill.style.padding = '4px 9px';
    pill.style.fontSize = '12px';
    pill.style.borderRadius = '999px';
    pill.style.margin = '0';
    pill.addEventListener('click', () => {
      selectOriginForIssue(origin.id);
    });
    container.append(pill);
  }
}

async function selectOriginForIssue(originId) {
  switchTab('issue');
  if (!origins || !origins.some((o) => o.id === originId)) {
    await refreshOriginChoices();
  }
  const select = $('issueOrigin');
  $('originSearch').value = '';
  renderOriginChoices();
  select.value = originId;
  renderSelectedOrigin();
  renderQuickOriginPills();
  $('issueCount')?.focus();
  window.scrollTo({top: $('issueForm').offsetTop - 60, behavior: 'smooth'});
}

function renderSelectedOrigin() {
  const select = $('issueOrigin');
  const chosen = origins.find((origin) => origin.id === select.value);
  const opm = $('originPartnerManager');
  const submitBtn = $('issueSubmitBtn');

  if (!chosen) {
    $('originSelectedInfo').textContent = '';
    if (opm) opm.hidden = true;
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  const isContracted = chosen.source === 'origin' || chosen.status === 'parceiro';

  $('originSelectedInfo').textContent = chosen.source === 'prospect'
    ? `${categoryLabels[chosen.category] || chosen.category} · ${partnerStatusLabels[chosen.status] || 'Pendente'}`
    : `${chosen.category} · Origem cadastrada pronta para emissão`;

  if (opm) {
    opm.hidden = false;
    $('opmName').textContent = chosen.name;
    $('opmCategory').textContent = categoryLabels[chosen.category] || chosen.category;
    const badge = $('opmStatusBadge');
    badge.textContent = isContracted ? 'Parceiro Contratado (Pronto)' : (partnerStatusLabels[chosen.status] || 'Não contratado');
    badge.className = `badge ${isContracted ? 'valid' : 'used'}`;

    const promoteBtn = $('opmPromoteBtn');
    if (promoteBtn) {
      promoteBtn.hidden = isContracted;
    }
  }

  if (submitBtn) {
    submitBtn.disabled = !isContracted;
    if (!isContracted) {
      notice(`"${chosen.name}" ainda não é parceiro contratado. Clique em "Contratar parceiro (1 clique)" para autorizar a emissão.`, 'error');
    } else {
      notice('');
    }
  }
}

async function refreshOriginChoices() {
  const select = $('issueOrigin');
  select.disabled = true;
  $('originHelp').textContent = 'Carregando origens...';
  try {
    origins = await api('origins/options');
    renderOriginChoices();
  } catch (error) {
    $('originHelp').textContent = `Não foi possível carregar as origens: ${error.message}. Clique em Atualizar origens.`;
    throw error;
  } finally {
    select.disabled = false;
  }
}

async function refreshOrigins() {
  await refreshOriginChoices();
  const result = await api(`origins?page=${originsPage}&page_size=20`);
  const list = $('originList');
  list.replaceChildren();
  for (const origin of result.items) {
    const card = node('div', 'origin-card');
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.justifyContent = 'space-between';
    card.style.gap = '12px';

    const info = node('div');
    const title = node('strong', '', origin.name);
    title.style.fontSize = '16px';
    const cat = node('span', 'badge', origin.category);
    cat.style.marginTop = '6px';
    cat.style.display = 'inline-block';
    info.append(title, cat);

    const issueBtn = node('button', 'primary', '🎟️ Gerar cartões para esta origem');
    issueBtn.type = 'button';
    issueBtn.style.padding = '8px 12px';
    issueBtn.style.fontSize = '13px';
    issueBtn.addEventListener('click', () => {
      selectOriginForIssue(origin.id);
    });

    card.append(info, issueBtn);
    list.append(card);
  }
  if (!result.items.length) list.append(node('p', '', 'Nenhuma origem cadastrada.'));
  renderPager('origins', result);
}

function formatDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('pt-BR');
}

function statusLabel(card) {
  if (card.status === 'redeemed') return ['Utilizado', 'used'];
  if (card.expired) return ['Vencido', 'expired'];
  return ['Válido', 'valid'];
}

async function refreshCards() {
  const result = await api(`cards?page=${cardsPage}&page_size=20`);
  const cards = result.items;
  currentCardsList = cards;
  const body = $('cardsBody');
  body.replaceChildren();

  for (const card of cards) {
    const row = node('tr');
    const isSelected = selectedCardTokens.has(card.token);
    if (isSelected) row.classList.add('card-row-selected');

    // Coluna 1: Checkbox de seleção
    const selectCell = node('td');
    selectCell.style.textAlign = 'center';
    selectCell.style.width = '36px';
    const rowCheck = node('input');
    rowCheck.type = 'checkbox';
    rowCheck.className = 'card-select-check';
    rowCheck.checked = isSelected;
    rowCheck.title = `Selecionar ${card.number}`;
    selectCell.append(rowCheck);

    const [label, css] = statusLabel(card);
    const status = node('span', `badge ${css}`, label);
    const statusCell = node('td');
    statusCell.append(status);

    const actionWrap = node('div', 'button-row');
    actionWrap.style.margin = '0';
    actionWrap.style.gap = '8px';

    // Checkbox dentro de Ações (solicitação direta "Em acoes, eu quero um check")
    const actionCheckLabel = node('label', 'action-check-label');
    const actionCheck = node('input');
    actionCheck.type = 'checkbox';
    actionCheck.checked = isSelected;
    actionCheckLabel.append(actionCheck, document.createTextNode(' Sel.'));
    actionWrap.append(actionCheckLabel);

    function toggleSelect(checked) {
      if (checked) {
        selectedCardTokens.add(card.token);
        row.classList.add('card-row-selected');
      } else {
        selectedCardTokens.delete(card.token);
        row.classList.remove('card-row-selected');
      }
      rowCheck.checked = checked;
      actionCheck.checked = checked;
      updateBatchToolbar();
    }

    rowCheck.addEventListener('change', (e) => toggleSelect(e.target.checked));
    actionCheck.addEventListener('change', (e) => toggleSelect(e.target.checked));

    const action = node('button', '', 'Ver Cartão');
    action.type = 'button';
    action.style.padding = '5px 10px';
    action.style.fontSize = '12px';
    action.addEventListener('click', () => {
      renderIssued([card]);
      switchTab('issue');
      window.scrollTo({top: $('issuedCards').offsetTop - 60, behavior: 'smooth'});
    });

    const dlBtn = node('a', 'text-button', 'Baixar PNG ↓');
    dlBtn.href = new URL(`cards/${encodeURIComponent(card.token)}/card.png`, apiRoot).toString();
    dlBtn.download = `${card.number}.png`;
    dlBtn.style.padding = '5px 8px';
    dlBtn.style.fontSize = '12px';
    dlBtn.style.color = '#ff9e73';
    dlBtn.style.fontWeight = '700';

    actionWrap.append(action, dlBtn);

    if (card.status === 'issued' && !card.expired) {
      const redeemBtn = node('button', 'primary', 'Liberar Entrada');
      redeemBtn.type = 'button';
      redeemBtn.style.padding = '5px 8px';
      redeemBtn.style.fontSize = '12px';
      redeemBtn.addEventListener('click', async () => {
        const wb = window.prompt(`Confirmar entrada do cartão ${card.number}?\nNúmero da pulseira (opcional):`, '');
        if (wb === null) return;
        try {
          await api(`cards/${encodeURIComponent(card.token)}/redeem`, {
            method: 'POST', body: {wristband: wb.trim()},
          });
          notice(`✓ Cartão ${card.number} liberado com sucesso!`, 'success');
          await Promise.allSettled([refreshCards(), refreshScannedCards(), refreshReports()]);
        } catch (err) {
          notice(err.message, 'error');
        }
      });
      actionWrap.append(redeemBtn);
    }

    // Botão individual Apagar
    const delBtn = node('button', 'danger-btn', '🗑️ Apagar');
    delBtn.type = 'button';
    delBtn.style.padding = '5px 9px';
    delBtn.style.fontSize = '12px';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`Tem certeza que deseja apagar o cartão ${card.number}? Esta ação não pode ser desfeita.`)) return;
      try {
        delBtn.disabled = true;
        await api(`cards/${encodeURIComponent(card.token)}`, { method: 'DELETE' });
        selectedCardTokens.delete(card.token);
        notice(`✓ Cartão ${card.number} apagado com sucesso!`, 'success');
        await Promise.allSettled([refreshCards(), refreshScannedCards(), refreshReports()]);
      } catch (err) {
        notice(err.message, 'error');
        delBtn.disabled = false;
      }
    });
    actionWrap.append(delBtn);

    const actionCell = node('td');
    actionCell.append(actionWrap);

    row.append(
      selectCell,
      node('td', '', card.number),
      node('td', '', card.origin_name),
      statusCell,
      node('td', '', formatDate(card.issued_at)),
      actionCell
    );
    body.append(row);
  }
  if (!cards.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum cartão emitido ainda.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
  }
  renderPager('cards', result);
  updateBatchToolbar();
}

async function refreshScannedCards() {
  const result = await api(`cards?status=redeemed&page=${scannedPage}&page_size=20`);
  const cards = result.items;
  const body = $('scannedCardsBody');
  body.replaceChildren();
  for (const card of cards) {
    const row = node('tr');

    const status = node('span', 'badge valid', 'Entrada Confirmada');
    const statusCell = node('td');
    statusCell.append(status);

    const dateFormatted = formatDateTime(card.redeemed_at);

    row.append(
      node('td', '', card.number),
      node('td', '', card.origin_name || 'VIBZ TOURIST PASS'),
      node('td', '', dateFormatted),
      node('td', '', card.wristband || 'Sem pulseira'),
      node('td', '', card.redeemed_by_username || card.redeemed_by || 'Operador'),
      statusCell
    );
    body.append(row);
  }
  if (!cards.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum cartão lido ou entrada registrada até o momento.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
  }
  renderPager('scanned', result);
}

const categoryLabels = {hospedagem: 'Hospedagem', gastronomia: 'Gastronomia', praia: 'Praia'};
const partnerStatusLabels = {nao_contatado: 'Não contatado', contatado: 'Contatado', interessado: 'Interessado', parceiro: 'Parceiro confirmado'};
const priorityLabels = {baixa: 'Baixa', media: 'Média', alta: 'Alta'};

async function refreshPartners() {
  const params = new URLSearchParams({page: String(partnersPage), page_size: '20'});
  if ($('partnerQuery').value.trim()) params.set('q', $('partnerQuery').value.trim());
  if ($('partnerCategory').value) params.set('category', $('partnerCategory').value);
  if ($('partnerStatus').value) params.set('status', $('partnerStatus').value);
  const result = await api(`partners?${params}`);
  const body = $('partnersBody');
  body.replaceChildren();
  for (const partner of result.items) {
    const row = node('tr');
    const action = node('button', '', 'Ver / editar');
    action.type = 'button';
    action.addEventListener('click', () => editPartner(partner));
    if (session?.role !== 'admin') action.textContent = 'Ver detalhes';
    const actionCell = node('td');
    actionCell.append(action);
    row.append(node('td', '', partner.name), node('td', '', categoryLabels[partner.category]),
      node('td', '', partnerStatusLabels[partner.status]), node('td', '', priorityLabels[partner.priority]), actionCell);
    body.append(row);
  }
  if (!result.items.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum estabelecimento encontrado.');
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
  renderPager('partners', result);
}

function editPartner(partner) {
  selectedPartner = partner;
  const form = $('partnerEdit');
  $('partnerEditTitle').textContent = partner.name;
  for (const field of form.elements) {
    if (field.name && Object.hasOwn(partner, field.name)) {
      field.value = partner[field.name] ?? '';
      field.disabled = session?.role !== 'admin';
    }
  }
  form.querySelector('button[type="submit"]').hidden = session?.role !== 'admin';
  form.hidden = false;
  form.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function renderIssued(cards) {
  issuedTokens = cards.map((c) => c.token).filter(Boolean);
  const target = $('issuedCards');
  target.replaceChildren();
  for (const card of cards) {
    const item = node('article', 'card-preview-item');
    const cardImgUrl = card.card_data_url || new URL(`cards/${encodeURIComponent(card.token)}/card.png`, apiRoot).toString();

    const image = node('img', 'card-full-img');
    image.alt = `Cartão VIP ${card.number}`;
    image.src = cardImgUrl;

    const btnRow = node('div', 'button-row');
    btnRow.style.margin = '4px 0 0 0';
    btnRow.style.width = '100%';

    const dlBtn = node('a', 'primary dl-card-btn', `⬇️ Baixar PNG (${card.number})`);
    dlBtn.href = cardImgUrl;
    dlBtn.download = `${card.number}-CARTAO-VIP.png`;

    btnRow.append(dlBtn);
    item.append(image, btnRow);
    target.append(item);
  }
  $('issuedActions').hidden = cards.length === 0;
  $('issuedCount').textContent = `${cards.length} cartão(ões) completo(s) gerado(s) em alta resolução e salvo(s) no banco.`;
}

function renderCard(card) {
  const target = $('cardResult');
  target.replaceChildren();
  const panel = node('div', 'result-grid');
  const [label, css] = statusLabel(card);
  const badge = node('span', `badge ${css}`, label);
  const details = node('dl');
  const fields = [
    ['Origem', card.origin_name],
    ['Número', card.number],
    ['Emitido em', formatDate(card.issued_at)],
    ['Válido até', card.valid_until || 'Sem prazo definido'],
  ];
  if (card.status === 'redeemed') {
    fields.push(
      ['Entrada', formatDateTime(card.redeemed_at)],
      ['Pulseira', card.wristband || 'Sem pulseira'],
      ['Liberado por', card.redeemed_by_username || card.redeemed_by || 'Operador']
    );
  }
  for (const [title, value] of fields) {
    const cell = node('div');
    cell.append(node('dt', '', title), node('dd', '', value));
    details.append(cell);
  }
  panel.append(badge, node('h3', '', card.number), details);
  if (card.status === 'issued' && !card.expired) {
    const form = node('form', 'redeem-form');
    const label = node('label', '', 'Número da pulseira (opcional)');
    const input = node('input');
    input.required = false;
    input.maxLength = 32;
    input.placeholder = 'Opcional (ex.: 0387)';
    label.append(input);
    const button = node('button', 'primary', '✓ Confirmar e Liberar Entrada');
    button.type = 'submit';
    form.append(label, button);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        const updated = await api(`cards/${encodeURIComponent(card.token)}/redeem`, {
          method: 'POST', body: {wristband: input.value.trim()},
        });
        renderCard(updated);
        notice(`✓ ${updated.number} liberado com sucesso! ${updated.wristband ? `Pulseira ${updated.wristband} vinculada.` : ''}`, 'success');
        await Promise.allSettled([refreshCards(), refreshScannedCards(), refreshReports()]);
      } catch (error) {
        notice(error.message, 'error');
        button.disabled = false;
      }
    });
    panel.append(form);
  } else {
    panel.append(node('p', 'message error', card.status === 'redeemed'
      ? 'Este QR já foi utilizado. Não libere uma segunda entrada.'
      : 'Este cartão venceu. Não libere a entrada.'));
  }
  target.append(panel);
}

function playBling() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const osc1 = ctx.createOscillator();
    osc1.connect(gain);
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(988, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(1480, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.55, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.35);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1976, ctx.currentTime + 0.06);
    gain2.gain.setValueAtTime(0.25, ctx.currentTime + 0.06);
    gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc2.start(ctx.currentTime + 0.06);
    osc2.stop(ctx.currentTime + 0.45);
  } catch (_) { /* AudioContext indisponível — silêncio */ }
}

async function lookupQr(value) {
  const card = await api('lookup', {method: 'POST', body: {qr: value}});
  renderCard(card);
  stopCamera();
  const valid = card.status === 'issued' && !card.expired;
  if (valid) playBling();
  notice(`${card.number} identificado: ${card.origin_name}.`, valid ? 'success' : 'error');
}

function stopCamera() {
  scanActive = false;
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $('camera').srcObject = null;
  $('camera').hidden = true;
  $('cameraPlaceholder').hidden = false;
}

async function scanFrame(timestamp) {
  if (!scanActive) return;
  requestAnimationFrame(scanFrame);
  if (scanBusy || timestamp - lastFrame < 180 || $('camera').readyState < 2) return;
  lastFrame = timestamp;
  scanBusy = true;
  try {
    const video = $('camera');
    let value = null;
    if (detectorSupported) {
      try {
        const found = await new BarcodeDetector({formats: ['qr_code']}).detect(video);
        value = found[0]?.rawValue || null;
      } catch (_) {
        detectorSupported = false;
      }
    }
    if (!detectorSupported && window.jsQR) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.drawImage(video, 0, 0);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      value = window.jsQR(image.data, image.width, image.height)?.data || null;
    }
    if (value && scanActive) await lookupQr(value);
  } catch (error) {
    notice(error.message, 'error');
    stopCamera();
  } finally {
    scanBusy = false;
  }
}

async function startCamera() {
  const placeholder = $('cameraPlaceholder');
  if (!navigator.mediaDevices?.getUserMedia) {
    const msg = 'A câmera exige HTTPS e permissão do navegador.';
    placeholder.innerHTML = `<span style="color:#ff8790;padding:12px;display:block">${msg}</span>`;
    throw new Error(msg);
  }
  stopCamera();
  placeholder.textContent = 'Conectando câmera...';
  try {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (_) {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }
    const video = $('camera');
    video.srcObject = cameraStream;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.muted = true;
    video.hidden = false;
    placeholder.hidden = true;
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.onloadedmetadata = () => resolve();
    });
    await video.play();
    scanActive = true;
    requestAnimationFrame(scanFrame);
  } catch (error) {
    stopCamera();
    placeholder.innerHTML = `<div style="color:#ff8790;padding:12px"><strong>Não foi possível abrir a câmera:</strong><br>${error.message}</div>`;
    throw error;
  }
}

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginMessage').textContent = '';
  try {
    const data = await api('login', {method: 'POST', body: {username: $('username').value.trim(), password: $('password').value}});
    $('password').value = '';
    await showLoggedIn(data);
  } catch (error) {
    $('loginMessage').textContent = error.message;
    $('password').value = '';
  }
});
$('logoutButton').addEventListener('click', async () => {
  try {
    await api('logout', {method: 'POST'});
    showLoggedOut();
  } catch (error) {
    notice(error.message, 'error');
  }
});
$('originForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const created = await api('origins', {method: 'POST', body: {name: $('originName').value.trim(), category: $('originCategory').value}});
    event.target.reset();
    originsPage = 1;
    await refreshOrigins();
    notice(`✓ Origem "${created.name}" cadastrada com sucesso! Selecionada para gerar cartões.`, 'success');
    if (created && created.id) {
      await selectOriginForIssue(created.id);
    }
  } catch (error) { notice(error.message, 'error'); }
});
$('cardsPrev').addEventListener('click', () => { cardsPage--; refreshCards().catch((error) => notice(error.message, 'error')); });
$('cardsNext').addEventListener('click', () => { cardsPage++; refreshCards().catch((error) => notice(error.message, 'error')); });
$('originsPrev').addEventListener('click', () => { originsPage--; refreshOrigins().catch((error) => notice(error.message, 'error')); });
$('originsNext').addEventListener('click', () => { originsPage++; refreshOrigins().catch((error) => notice(error.message, 'error')); });
$('usersPrev').addEventListener('click', () => { usersPage--; refreshUsers().catch((error) => notice(error.message, 'error')); });
$('usersNext').addEventListener('click', () => { usersPage++; refreshUsers().catch((error) => notice(error.message, 'error')); });
$('userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (session?.role !== 'admin') return;
  const password = $('newPassword').value;
  if (password !== $('confirmPassword').value) {
    notice('As senhas não coincidem.', 'error');
    return;
  }
  const role = $('newRole').value;
  if (role === 'admin' && !window.confirm('Este usuário terá acesso completo, inclusive emissão de cartões e cadastro de outros administradores. Continuar?')) return;
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('users', {method: 'POST', body: {username: $('newUsername').value.trim(), password, role}});
    event.target.reset();
    usersPage = 1;
    await refreshUsers();
    notice('Usuário cadastrado. Informe a senha inicial por um canal privado.', 'success');
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('originSearch').addEventListener('input', renderOriginChoices);
$('issueOrigin').addEventListener('change', renderSelectedOrigin);
$('refreshOriginChoices').addEventListener('click', () => refreshOriginChoices().catch((error) => notice(error.message, 'error')));
$('partnersPrev').addEventListener('click', () => { partnersPage--; refreshPartners().catch((error) => notice(error.message, 'error')); });
$('partnersNext').addEventListener('click', () => { partnersPage++; refreshPartners().catch((error) => notice(error.message, 'error')); });
$('partnerFilter').addEventListener('submit', (event) => {
  event.preventDefault();
  partnersPage = 1;
  $('partnerEdit').hidden = true;
  refreshPartners().catch((error) => notice(error.message, 'error'));
});
$('cancelPartnerEdit').addEventListener('click', () => { $('partnerEdit').hidden = true; selectedPartner = null; });

$('partnerEdit').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedPartner || session?.role !== 'admin') return;
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const formElements = event.target.elements;
    const payload = {};
    const fields = ['neighborhood', 'address', 'phone', 'whatsapp', 'instagram', 'website', 'manager', 'estimated_rooms', 'priority', 'status'];
    for (const f of fields) {
      if (formElements[f]) {
        let val = formElements[f].value.trim();
        if (f === 'estimated_rooms') {
          payload[f] = val === '' ? null : Number(val);
        } else {
          payload[f] = val;
        }
      }
    }
    await api(`partners/${encodeURIComponent(selectedPartner.id)}`, {method: 'PATCH', body: payload});
    event.target.hidden = true;
    selectedPartner = null;
    await refreshPartners();
    await refreshOriginChoices();
    notice('Estabelecimento atualizado com sucesso.', 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

// Ações no Card do Parceiro Selecionado (na tela de Gerar Cartões)
$('opmPromoteBtn')?.addEventListener('click', async () => {
  const select = $('issueOrigin');
  const chosen = origins.find((origin) => origin.id === select.value);
  if (!chosen || chosen.source !== 'prospect') return;
  const btn = $('opmPromoteBtn');
  btn.disabled = true;
  btn.textContent = 'Contratando...';
  try {
    await api(`partners/${encodeURIComponent(chosen.id)}`, {
      method: 'PATCH',
      body: { status: 'parceiro' },
    });
    notice(`"${chosen.name}" marcado como Parceiro Contratado! Emissão de cartões liberada.`, 'success');
    await refreshOriginChoices();
    select.value = chosen.id;
    renderSelectedOrigin();
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Contratar parceiro (1 clique)';
  }
});

$('opmEditBtn')?.addEventListener('click', async () => {
  const select = $('issueOrigin');
  const chosen = origins.find((origin) => origin.id === select.value);
  if (!chosen) return;
  switchTab('partners');
  $('partnerQuery').value = chosen.name;
  await refreshPartners();
  editPartner(chosen);
});

$('issueForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const select = $('issueOrigin');
  const chosen = origins.find((origin) => origin.id === select.value);
  if (!chosen) {
    notice('Selecione uma origem ou parceiro.', 'error');
    return;
  }
  const isContracted = chosen.source === 'origin' || chosen.status === 'parceiro';
  if (!isContracted) {
    notice(`Não é permitido emitir cartões para estabelecimentos não contratados. Clique em "Contratar parceiro (1 clique)" acima.`, 'error');
    return;
  }
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Gerando e salvando...';
  try {
    const cards = await api('cards', {method: 'POST', body: {
      origin_id: select.value,
      count: Number($('issueCount').value),
      valid_until: $('issueExpiry').value || null,
    }});
    renderIssued(cards);
    cardsPage = 1;
    await refreshCards();
    notice(`Lote de ${cards.length} cartões salvo no banco com sucesso: ${cards[0].number} a ${cards[cards.length - 1].number}.`, 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Gerar lote';
  }
});

async function exportForPrint(tokens = issuedTokens) {
  if (!tokens || !tokens.length) { notice('Nenhum cartão selecionado para exportar.', 'error'); return; }
  const button = $('exportGrafica');
  if (button) { button.disabled = true; button.textContent = 'Gerando ZIP...'; }
  try {
    const response = await fetch(new URL('cards/export.zip', apiRoot), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/zip',
        ...(session?.csrf_token ? {'X-CSRF-Token': session.csrf_token} : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({tokens}),
    });
    if (!response.ok) {
      let msg = 'Falha ao gerar ZIP';
      try { msg = (await response.json()).detail || msg; } catch (_) { /* keep */ }
      throw new Error(msg);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vibz-lote-grafica-${tokens.length}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    notice(`ZIP baixado com sucesso: ${tokens.length} cartões completos montados em PNG (1024x619) + PDF para gráfica + QR codes vetoriais + CSV.`, 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Exportar para gráfica (ZIP) ↓'; }
  }
}

async function refreshReports() {
  const period = $('reportPeriod')?.value || '30';
  const origin = $('reportOriginFilter')?.value || 'all';

  let days = 30;
  if (period === 'today') days = 1;
  else if (!isNaN(Number(period))) days = Number(period);

  const queryParams = new URLSearchParams();
  queryParams.set('days', String(days));
  if (origin && origin !== 'all') queryParams.set('origin_id', origin);

  const data = await api(`reports/admissions?${queryParams.toString()}`);
  currentReportData = data;

  const sum = data.summary || {};
  $('kpiTotalIssued').textContent = (sum.total_issued || 0).toLocaleString();
  $('kpiTodayIssued').textContent = `${(sum.today_issued || 0).toLocaleString()} hoje`;

  $('kpiTotalAdmissions').textContent = (sum.total_admissions || 0).toLocaleString();
  $('kpiTodayAdmissions').textContent = `${(sum.today_admissions || 0).toLocaleString()} hoje`;

  $('kpiTotalUnused').textContent = (sum.total_unused || 0).toLocaleString();
  $('kpiTodayUnused').textContent = `${(sum.today_unused || 0).toLocaleString()} hoje`;

  $('kpiConversionRate').textContent = `${sum.conversion_rate || 0}%`;
  $('kpiTodayConvRate').textContent = `${sum.today_conversion_rate || 0}% hoje`;

  renderDailyBarChart(data.daily || []);
  renderStatusDonutChart(sum);
  renderHourlyChart(data.hourly_today || []);
  renderReportDailyTable(data.daily || []);
  renderReportPartnersTable(data.partners || []);
}

function renderDailyBarChart(daily) {
  const container = $('dailyChartContainer');
  if (!container) return;
  container.replaceChildren();

  if (!daily.length) {
    container.innerHTML = '<div class="empty-state" style="min-height:160px">Nenhuma movimentação registrada no período selecionado.</div>';
    return;
  }

  const items = [...daily].reverse();
  const maxVal = Math.max(1, ...items.map(d => Math.max(d.issued, d.admissions, d.unused)));

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  const viewW = Math.max(500, items.length * 70);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "220");
  svg.setAttribute("viewBox", `0 0 ${viewW} 220`);
  svg.style.overflow = "visible";

  const chartHeight = 150;
  const colWidth = viewW / items.length;

  items.forEach((d, i) => {
    const x = i * colWidth + colWidth * 0.12;
    const barW = colWidth * 0.24;

    const hIssued = (d.issued / maxVal) * chartHeight;
    const hAdm = (d.admissions / maxVal) * chartHeight;
    const hUnused = (d.unused / maxVal) * chartHeight;

    const g = document.createElementNS(svgNS, "g");

    const rectIssued = document.createElementNS(svgNS, "rect");
    rectIssued.setAttribute("x", x);
    rectIssued.setAttribute("y", chartHeight - hIssued + 20);
    rectIssued.setAttribute("width", barW);
    rectIssued.setAttribute("height", Math.max(2, hIssued));
    rectIssued.setAttribute("fill", "#ff7b4b");
    rectIssued.setAttribute("rx", "3");
    const titleIssued = document.createElementNS(svgNS, "title");
    titleIssued.textContent = `${d.date}: ${d.issued} cartões emitidos`;
    rectIssued.appendChild(titleIssued);

    const rectAdm = document.createElementNS(svgNS, "rect");
    rectAdm.setAttribute("x", x + barW + 3);
    rectAdm.setAttribute("y", chartHeight - hAdm + 20);
    rectAdm.setAttribute("width", barW);
    rectAdm.setAttribute("height", Math.max(2, hAdm));
    rectAdm.setAttribute("fill", "#44d99e");
    rectAdm.setAttribute("rx", "3");
    const titleAdm = document.createElementNS(svgNS, "title");
    titleAdm.textContent = `${d.date}: ${d.admissions} entradas confirmadas`;
    rectAdm.appendChild(titleAdm);

    const rectUnused = document.createElementNS(svgNS, "rect");
    rectUnused.setAttribute("x", x + (barW + 3) * 2);
    rectUnused.setAttribute("y", chartHeight - hUnused + 20);
    rectUnused.setAttribute("width", barW);
    rectUnused.setAttribute("height", Math.max(2, hUnused));
    rectUnused.setAttribute("fill", "#7e7492");
    rectUnused.setAttribute("rx", "3");
    const titleUnused = document.createElementNS(svgNS, "title");
    titleUnused.textContent = `${d.date}: ${d.unused} não usados`;
    rectUnused.appendChild(titleUnused);

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", x + barW * 1.5);
    text.setAttribute("y", "195");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#a8a0b0");
    text.setAttribute("font-size", "11");
    text.textContent = d.date.slice(5);

    g.appendChild(rectIssued);
    g.appendChild(rectAdm);
    g.appendChild(rectUnused);
    g.appendChild(text);
    svg.appendChild(g);
  });

  container.appendChild(svg);
}

function renderStatusDonutChart(sum) {
  const container = $('statusChartContainer');
  if (!container) return;
  container.replaceChildren();

  const total = sum.total_issued || 0;
  const used = sum.total_admissions || 0;
  const unused = sum.total_unused || 0;

  if (total === 0) {
    container.innerHTML = '<div class="empty-state" style="min-height:160px">Nenhum cartão emitido ainda.</div>';
    return;
  }

  const usedPct = Math.round((used / total) * 100);
  const unusedPct = 100 - usedPct;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "150");
  svg.setAttribute("height", "150");
  svg.setAttribute("viewBox", "0 0 42 42");

  const radius = 15.91549430918954;
  const circ = 100;

  const circleBg = document.createElementNS(svgNS, "circle");
  circleBg.setAttribute("cx", "21");
  circleBg.setAttribute("cy", "21");
  circleBg.setAttribute("r", radius);
  circleBg.setAttribute("fill", "transparent");
  circleBg.setAttribute("stroke", "#241f2e");
  circleBg.setAttribute("stroke-width", "5");

  const circleUnused = document.createElementNS(svgNS, "circle");
  circleUnused.setAttribute("cx", "21");
  circleUnused.setAttribute("cy", "21");
  circleUnused.setAttribute("r", radius);
  circleUnused.setAttribute("fill", "transparent");
  circleUnused.setAttribute("stroke", "#ff7b4b");
  circleUnused.setAttribute("stroke-width", "5");
  circleUnused.setAttribute("stroke-dasharray", `${unusedPct} ${circ - unusedPct}`);
  circleUnused.setAttribute("stroke-dashoffset", "25");

  const circleUsed = document.createElementNS(svgNS, "circle");
  circleUsed.setAttribute("cx", "21");
  circleUsed.setAttribute("cy", "21");
  circleUsed.setAttribute("r", radius);
  circleUsed.setAttribute("fill", "transparent");
  circleUsed.setAttribute("stroke", "#44d99e");
  circleUsed.setAttribute("stroke-width", "5");
  circleUsed.setAttribute("stroke-dasharray", `${usedPct} ${circ - usedPct}`);
  circleUsed.setAttribute("stroke-dashoffset", `${25 - unusedPct}`);

  const textVal = document.createElementNS(svgNS, "text");
  textVal.setAttribute("x", "21");
  textVal.setAttribute("y", "21");
  textVal.setAttribute("text-anchor", "middle");
  textVal.setAttribute("dominant-baseline", "middle");
  textVal.setAttribute("fill", "#ffffff");
  textVal.setAttribute("font-size", "7");
  textVal.setAttribute("font-weight", "bold");
  textVal.textContent = `${usedPct}%`;

  const textLabel = document.createElementNS(svgNS, "text");
  textLabel.setAttribute("x", "21");
  textLabel.setAttribute("y", "27");
  textLabel.setAttribute("text-anchor", "middle");
  textLabel.setAttribute("dominant-baseline", "middle");
  textLabel.setAttribute("fill", "#a8a0b0");
  textLabel.setAttribute("font-size", "3");
  textLabel.textContent = "UTILIZADOS";

  svg.appendChild(circleBg);
  svg.appendChild(circleUnused);
  svg.appendChild(circleUsed);
  svg.appendChild(textVal);
  svg.appendChild(textLabel);

  const legend = node('div', 'chart-legend');
  legend.style.display = 'flex';
  legend.style.flexDirection = 'column';
  legend.style.gap = '6px';
  legend.style.marginTop = '12px';
  legend.style.fontSize = '12px';

  legend.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px">
      <span style="width:10px;height:10px;background:#44d99e;border-radius:2px"></span>
      <span>Entraram no VIBZ: <strong>${used} (${usedPct}%)</strong></span>
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <span style="width:10px;height:10px;background:#ff7b4b;border-radius:2px"></span>
      <span>Receberam e não usaram: <strong>${unused} (${unusedPct}%)</strong></span>
    </div>
  `;

  container.append(svg, legend);
}

function renderHourlyChart(hourly) {
  const container = $('hourlyChartContainer');
  if (!container) return;
  container.replaceChildren();

  const maxVal = Math.max(1, ...hourly.map(h => h.count));
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "120");
  svg.setAttribute("viewBox", "0 0 720 120");

  const chartHeight = 80;
  const colW = 720 / 24;

  hourly.forEach((h, i) => {
    const barH = (h.count / maxVal) * chartHeight;
    const x = i * colW + 4;
    const y = chartHeight - barH + 15;

    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", colW - 8);
    rect.setAttribute("height", Math.max(1, barH));
    rect.setAttribute("fill", h.count > 0 ? "#44d99e" : "#25212f");
    rect.setAttribute("rx", "2");

    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${h.hour}h: ${h.count} entrada(s)`;
    rect.appendChild(title);

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", x + (colW - 8) / 2);
    text.setAttribute("y", "110");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#8d8795");
    text.setAttribute("font-size", "9");
    text.textContent = `${h.hour}h`;

    svg.appendChild(rect);
    svg.appendChild(text);
  });

  container.appendChild(svg);
}

function renderReportDailyTable(daily) {
  const body = $('reportDailyBody');
  if (!body) return;
  body.replaceChildren();

  for (const d of daily) {
    const row = node('tr');
    row.append(
      node('td', '', d.date),
      node('td', '', d.issued.toLocaleString()),
      node('td', '', d.admissions.toLocaleString()),
      node('td', '', d.unused.toLocaleString()),
      node('td', '', `${d.conversion_rate}%`)
    );
    body.append(row);
  }
  if (!daily.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhuma movimentação no período.');
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
}

function renderReportPartnersTable(partners) {
  const body = $('reportPartnersBody');
  if (!body) return;
  body.replaceChildren();

  for (const p of partners) {
    const row = node('tr');
    row.append(
      node('td', '', p.origin_name || 'Sem parceiro'),
      node('td', '', p.issued.toLocaleString()),
      node('td', '', p.admissions.toLocaleString()),
      node('td', '', p.unused.toLocaleString()),
      node('td', '', `${p.conversion_rate}%`)
    );
    body.append(row);
  }
  if (!partners.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum estabelecimento com cartões emitidos.');
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
}

function exportReportCsv() {
  if (!currentReportData) return;
  const rows = [
    ["RELATORIO DE ENTRADAS E CARTOES - VIBZ MUSIC BAR"],
    ["Emitido em", new Date().toLocaleString()],
    [],
    ["RESUMO DO PERIODO"],
    ["Total Cartoes Emitidos", currentReportData.summary.total_issued],
    ["Total Entradas Realizadas", currentReportData.summary.total_admissions],
    ["Receberam e Nao Usaram", currentReportData.summary.total_unused],
    ["Taxa de Presenca", `${currentReportData.summary.conversion_rate}%`],
    [],
    ["MOVIMENTACAO DIARIA"],
    ["Data", "Cartoes Entregues", "Entradas Confirmadas", "Nao Utilizados", "Taxa Conversao %"]
  ];

  for (const d of currentReportData.daily || []) {
    rows.push([d.date, d.issued, d.admissions, d.unused, `${d.conversion_rate}%`]);
  }

  rows.push([]);
  rows.push(["PERFORMANCE POR PARCEIRO / ORIGEM"]);
  rows.push(["Parceiro", "Cartoes Emitidos", "Entradas Realizadas", "Nao Usados", "Taxa Comparecimento %"]);

  for (const p of currentReportData.partners || []) {
    rows.push([p.origin_name, p.issued, p.admissions, p.unused, `${p.conversion_rate}%`]);
  }

  const csvContent = "\ufeff" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csvContent], {type: "text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vibz-relatorio-entradas-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Fallback manual na leitura de QR
$('toggleManualCode')?.addEventListener('click', () => {
  const form = $('manualLookupForm');
  form.hidden = !form.hidden;
  if (!form.hidden) $('manualQrInput').focus();
});
$('manualLookupForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const val = $('manualQrInput').value.trim();
  if (!val) return;
  try {
    await lookupQr(val);
    $('manualQrInput').value = '';
  } catch (err) {
    notice(err.message, 'error');
  }
});

$('printCards').addEventListener('click', () => window.print());
$('exportGrafica').addEventListener('click', () => exportForPrint());
$('exportRecentGrafica')?.addEventListener('click', () => {
  const tokens = currentCardsList.map(c => c.token).filter(Boolean);
  if (!tokens.length) { notice('Nenhum cartão nesta página para exportar.', 'error'); return; }
  exportForPrint(tokens);
});
$('refreshCards').addEventListener('click', () => refreshCards().catch((error) => notice(error.message, 'error')));
$('cardsPrev').addEventListener('click', () => { cardsPage--; selectedCardTokens.clear(); refreshCards().catch((error) => notice(error.message, 'error')); });
$('cardsNext').addEventListener('click', () => { cardsPage++; selectedCardTokens.clear(); refreshCards().catch((error) => notice(error.message, 'error')); });

$('selectAllCards')?.addEventListener('change', (e) => {
  const checked = e.target.checked;
  for (const card of currentCardsList) {
    if (checked) {
      selectedCardTokens.add(card.token);
    } else {
      selectedCardTokens.delete(card.token);
    }
  }
  document.querySelectorAll('.card-select-check, .action-check-label input').forEach((chk) => {
    chk.checked = checked;
  });
  document.querySelectorAll('#cardsBody tr').forEach((row) => {
    row.classList.toggle('card-row-selected', checked);
  });
  updateBatchToolbar();
});

$('clearSelectionCardsBtn')?.addEventListener('click', () => {
  selectedCardTokens.clear();
  document.querySelectorAll('.card-select-check, .action-check-label input').forEach((chk) => {
    chk.checked = false;
  });
  document.querySelectorAll('#cardsBody tr').forEach((row) => {
    row.classList.remove('card-row-selected');
  });
  updateBatchToolbar();
});

$('deleteBatchCardsBtn')?.addEventListener('click', async () => {
  const count = selectedCardTokens.size;
  if (!count) return;
  if (!window.confirm(`Tem certeza que deseja apagar os ${count} cartão(ões) selecionado(s) em lote? Esta ação é definitiva.`)) return;
  const btn = $('deleteBatchCardsBtn');
  try {
    btn.disabled = true;
    const tokens = Array.from(selectedCardTokens);
    const resp = await api('cards/delete-batch', { method: 'POST', body: { tokens } });
    selectedCardTokens.clear();
    notice(`✓ ${resp.deleted_count} cartão(ões) apagado(s) em lote com sucesso!`, 'success');
    await Promise.allSettled([refreshCards(), refreshScannedCards(), refreshReports()]);
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('refreshScannedCards')?.addEventListener('click', () => refreshScannedCards().catch((error) => notice(error.message, 'error')));
$('scannedPrev')?.addEventListener('click', () => { scannedPage--; refreshScannedCards().catch((error) => notice(error.message, 'error')); });
$('scannedNext')?.addEventListener('click', () => { scannedPage++; refreshScannedCards().catch((error) => notice(error.message, 'error')); });

$('exportReportCsv')?.addEventListener('click', exportReportCsv);
$('printReportBtn')?.addEventListener('click', () => window.print());
$('refreshReportsBtn')?.addEventListener('click', () => refreshReports().catch((error) => notice(error.message, 'error')));
$('reportPeriod')?.addEventListener('change', () => refreshReports().catch((error) => notice(error.message, 'error')));
$('reportOriginFilter')?.addEventListener('change', () => refreshReports().catch((error) => notice(error.message, 'error')));

$('originsPrev').addEventListener('click', () => { originsPage--; refreshOrigins().catch((error) => notice(error.message, 'error')); });
$('originsNext').addEventListener('click', () => { originsPage++; refreshOrigins().catch((error) => notice(error.message, 'error')); });
$('usersPrev').addEventListener('click', () => { usersPage--; refreshUsers().catch((error) => notice(error.message, 'error')); });
$('usersNext').addEventListener('click', () => { usersPage++; refreshUsers().catch((error) => notice(error.message, 'error')); });
$('startCamera').addEventListener('click', () => startCamera().catch((error) => notice(error.message, 'error')));
$('stopCamera').addEventListener('click', stopCamera);
window.addEventListener('pagehide', stopCamera);

api('session').then(showLoggedIn).catch(() => showLoggedOut());

