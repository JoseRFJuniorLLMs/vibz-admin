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

function applyTheme(theme) {
  const isLight = theme === 'light';
  if (isLight) {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try { localStorage.setItem('vibz-theme', isLight ? 'light' : 'dark'); } catch (_) {}
  $('themeLightBtn')?.classList.toggle('active', isLight);
  $('themeDarkBtn')?.classList.toggle('active', !isLight);
}

try {
  const savedTheme = localStorage.getItem('vibz-theme') || 'dark';
  applyTheme(savedTheme);
} catch (_) {}

$('themeLightBtn')?.addEventListener('click', () => applyTheme('light'));
$('themeDarkBtn')?.addEventListener('click', () => applyTheme('dark'));

function formatDateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatMoney(value) {
  const num = Number(value) || 0;
  return `R$ ${num.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
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
    try {
      const data = await response.json();
      if (typeof data?.detail === 'string') {
        detail = data.detail;
      } else if (Array.isArray(data?.detail) && data.detail.length > 0) {
        detail = data.detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
      } else if (typeof data?.message === 'string') {
        detail = data.message;
      }
    } catch (_) { /* keep default */ }
    if (response.status === 401 && path !== 'login') showLoggedOut();
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showLoggedOut() {
  stopCamera();
  stopBarCamera();
  session = null;
  origins = [];
  selectedCardTokens.clear();
  currentBarCart = [];
  currentBarCard = null;
  if ($('barCardStatusBox')) $('barCardStatusBox').style.display = 'none';
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

  const role = (data.role || '').toLowerCase();
  const username = (data.username || '').toLowerCase();
  const isAdmin = role === 'admin';
  const isBar = !isAdmin && (role === 'bar' || username === 'bar');
  const isVendaCartao = !isAdmin && !isBar && (role === 'venda_cartao' || username === 'venda_cartao');
  const isPortaria = !isAdmin && !isBar && !isVendaCartao;

  let roleLabel = 'administrador';
  if (isBar) roleLabel = 'bar';
  else if (isVendaCartao) roleLabel = 'venda de cartão';
  else if (isPortaria) roleLabel = 'portaria';

  $('accountName').textContent = `${data.username} · ${roleLabel}`;

  // Controle de menus por perfil:
  // - Portaria: apenas Ler QR da portaria
  // - Bar: apenas Ler QR do bar e lançar consumo
  // - Venda de Cartão: pode ter acesso ao menu gerar cartão e ler qrcode
  // - Administrador: acesso irrestrito
  document.querySelectorAll('.tab').forEach((tab) => {
    const tabName = tab.dataset.tab;
    if (isAdmin) {
      tab.hidden = false;
    } else if (isVendaCartao) {
      tab.hidden = !(tabName === 'issue' || tabName === 'scan');
    } else if (isPortaria) {
      tab.hidden = (tabName !== 'scan');
    } else if (isBar) {
      tab.hidden = (tabName !== 'bar');
    }
  });

  document.querySelectorAll('form.admin-only, .admin-only').forEach((element) => {
    if (!element.classList.contains('tab')) {
      if (element.id === 'issueForm') {
        element.hidden = !(isAdmin || isVendaCartao);
      } else {
        element.hidden = !isAdmin;
      }
    }
  });

  $('issueOperatorNote').hidden = (isAdmin || isVendaCartao);

  // Sub-abas do Bar: se não for admin, oculta gestão administrativa de cardápio, estoque e clientes
  if ($('barSubNavMenu')) $('barSubNavMenu').hidden = !isAdmin;
  if ($('barSubNavStock')) $('barSubNavStock').hidden = !isAdmin;
  if ($('barSubNavClients')) $('barSubNavClients').hidden = !isAdmin;

  if (isBar) {
    switchTab('bar');
    initBarModule().catch((error) => notice(error.message, 'error'));
  } else if (isVendaCartao) {
    switchTab('issue');
    refreshOrigins().catch((error) => notice(error.message, 'error'));
  } else {
    switchTab('scan');
    if (isAdmin) {
      const loads = await Promise.allSettled([refreshOrigins(), refreshCards(), refreshScannedCards()]);
      for (const result of loads) {
        if (result.status === 'rejected') notice(result.reason.message, 'error');
      }
    }
  }
}

function switchTab(name) {
  const role = (session?.role || '').toLowerCase();
  const username = (session?.username || '').toLowerCase();
  const isAdmin = role === 'admin';
  const isBar = !isAdmin && (role === 'bar' || username === 'bar');
  const isVendaCartao = !isAdmin && !isBar && (role === 'venda_cartao' || username === 'venda_cartao');
  const isPortaria = !isAdmin && !isBar && !isVendaCartao;

  if (isPortaria && name !== 'scan') name = 'scan';
  if (isBar && name !== 'bar') name = 'bar';
  if (isVendaCartao && name !== 'issue' && name !== 'scan') name = 'issue';

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
  if (name !== 'bar') stopBarCamera();
  if (name === 'issue' && isAdmin) refreshOriginChoices().catch((error) => notice(error.message, 'error'));
  if (name === 'cards' && isAdmin) refreshCards().catch((error) => notice(error.message, 'error'));
  if (name === 'scanned' && isAdmin) {
    scannedPage = 1;
    refreshScannedCards().catch((error) => notice(error.message, 'error'));
    scannedInterval = setInterval(() => {
      if (!$('scannedTab').hidden) {
        refreshScannedCards().catch(() => {});
      }
    }, 15000);
  }
  if (name === 'bar') initBarModule().catch((error) => notice(error.message, 'error'));
  if (name === 'menu' && isAdmin) refreshBarMenu().catch((error) => notice(error.message, 'error'));
  if (name === 'stock' && isAdmin) refreshStock().catch((error) => notice(error.message, 'error'));
  if (name === 'reports' && isAdmin) refreshReports().catch((error) => notice(error.message, 'error'));
  if (name === 'origins' && isAdmin) refreshOrigins().catch((error) => notice(error.message, 'error'));
  if (name === 'partners' && isAdmin) refreshPartners().catch((error) => notice(error.message, 'error'));
  if (name === 'users' && isAdmin) refreshUsers().catch((error) => notice(error.message, 'error'));
  notice('');
}

function renderPager(prefix, result) {
  const pageCount = Math.max(1, result.pages);
  $(`${prefix}Page`).textContent = `${result.total} registro(s) · página ${result.page} de ${pageCount}`;
  $(`${prefix}Prev`).disabled = result.page <= 1;
  $(`${prefix}Next`).disabled = result.page >= pageCount;
}

function editUser(user) {
  $('userEditId').value = user.id;
  $('userEditBanner').style.display = 'flex';
  $('userFormTitle').textContent = `✏️ Editando: ${user.username}`;
  $('newUsername').value = user.username;
  $('newUsername').disabled = true;
  $('newRole').value = user.role;
  $('lblUserActive').style.display = 'block';
  $('userActive').value = user.active ? '1' : '0';
  $('newPassword').value = '';
  $('newPassword').required = false;
  $('confirmPassword').value = '';
  $('confirmPassword').required = false;
  $('pwdHint').textContent = '(deixe em branco para manter a atual)';
  $('userSubmitBtn').textContent = 'Salvar alterações';
  $('userForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetUserForm() {
  $('userEditId').value = '';
  $('userEditBanner').style.display = 'none';
  $('newUsername').value = '';
  $('newUsername').disabled = false;
  $('newPassword').value = '';
  $('newPassword').required = true;
  $('confirmPassword').value = '';
  $('confirmPassword').required = true;
  $('pwdHint').textContent = '(mín. 12 caracteres)';
  $('lblUserActive').style.display = 'none';
  $('userActive').value = '1';
  $('newRole').value = 'portaria';
  $('userSubmitBtn').textContent = 'Cadastrar usuário';
}

async function refreshUsers() {
  const result = await api(`users?page=${usersPage}&page_size=20`);
  const body = $('usersBody');
  body.replaceChildren();
  for (const user of result.items) {
    const row = node('tr');
    let roleTxt = 'Portaria';
    if (user.role === 'admin') roleTxt = 'Administrador';
    else if (user.role === 'bar') roleTxt = 'Bar';
    else if (user.role === 'venda_cartao') roleTxt = 'Venda de Cartão';

    const actionsCell = node('td');
    actionsCell.style.display = 'flex';
    actionsCell.style.gap = '6px';
    actionsCell.style.alignItems = 'center';

    const editBtn = node('button', '', '✏️ Editar');
    editBtn.type = 'button';
    editBtn.style.padding = '4px 10px';
    editBtn.style.fontSize = '12px';
    editBtn.onclick = () => editUser(user);
    actionsCell.append(editBtn);

    if (session && session.id !== user.id) {
      const delBtn = node('button', 'danger-btn', '🗑️ Excluir');
      delBtn.type = 'button';
      delBtn.style.padding = '4px 10px';
      delBtn.style.fontSize = '12px';
      delBtn.onclick = async () => {
        if (!window.confirm(`Tem certeza que deseja excluir o usuário "${user.username}"?`)) return;
        try {
          await api(`users/${user.id}`, { method: 'DELETE' });
          notice(`Usuário "${user.username}" excluído com sucesso.`, 'success');
          if ($('userEditId').value === String(user.id)) resetUserForm();
          await refreshUsers();
        } catch (err) {
          notice(err.message, 'error');
        }
      };
      actionsCell.append(delBtn);
    }

    row.append(
      node('td', '', user.username),
      node('td', '', roleTxt),
      node('td', '', user.active ? 'Ativo' : 'Inativo'),
      node('td', '', formatDate(user.created_at)),
      actionsCell
    );
    body.append(row);
  }
  if (!result.items.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum usuário cadastrado.');
    cell.colSpan = 5;
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
  if (card.active === false || card.active === 0) return ['Inativado', 'expired'];
  if (card.status === 'redeemed') return ['Utilizado', 'used'];
  if (card.expired) return ['Vencido', 'expired'];
  return ['Válido', 'valid'];
}

async function refreshCards() {
  const result = await api(`cards?page=${cardsPage}&page_size=20`);
  if (result.items.length === 0 && result.total > 0 && cardsPage > 1) {
    cardsPage = Math.max(1, Math.ceil(result.total / 20));
    return refreshCards();
  }
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

    if (card.status === 'issued' && !card.expired && card.active !== false && card.active !== 0) {
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

    const isUserAdmin = session?.role === 'admin';
    if (isUserAdmin) {
      const editCardBtn = node('button', '', '✏️ Editar');
      editCardBtn.type = 'button';
      editCardBtn.style.padding = '5px 9px';
      editCardBtn.style.fontSize = '12px';
      editCardBtn.style.background = '#1e1c2e';
      editCardBtn.style.borderColor = '#6b5a8e';
      editCardBtn.style.color = '#e2dcfa';
      editCardBtn.style.fontWeight = '700';
      editCardBtn.title = `Editar validade e ativação do cartão ${card.number}`;
      editCardBtn.addEventListener('click', () => openCardEdit(card));
      actionWrap.append(editCardBtn);
    }

    // Botão Consumo
    const consBtn = node('button', '', '🍸 Consumo');
    consBtn.type = 'button';
    consBtn.style.padding = '5px 9px';
    consBtn.style.fontSize = '12px';
    consBtn.style.background = '#281a33';
    consBtn.style.borderColor = '#bd468a';
    consBtn.style.color = '#ff9e73';
    consBtn.style.fontWeight = '700';
    consBtn.title = `Ver consumo e extrato do cartão ${card.number}`;
    consBtn.addEventListener('click', () => openCardConsumption(card.number));
    actionWrap.append(consBtn);

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
    const qrImgUrl = new URL(`cards/${encodeURIComponent(card.token)}/qr.svg`, apiRoot).toString();

    const rowWrap = node('div', 'card-preview-split');
    rowWrap.style.display = 'flex';
    rowWrap.style.alignItems = 'stretch';
    rowWrap.style.justifyContent = 'center';
    rowWrap.style.gap = '16px';
    rowWrap.style.flexWrap = 'wrap';
    rowWrap.style.width = '100%';

    // Lado Esquerdo: Cartão VIP
    const cardCol = node('div');
    cardCol.style.flex = '1 1 360px';
    cardCol.style.maxWidth = '520px';
    cardCol.style.display = 'flex';
    cardCol.style.flexDirection = 'column';
    cardCol.style.gap = '8px';

    const cardTitle = node('div', '', `💳 Cartão VIP · ${card.number}`);
    cardTitle.style.fontSize = '14px';
    cardTitle.style.fontWeight = '700';
    cardTitle.style.color = '#ff9e73';

    const cardImg = node('img', 'card-full-img');
    cardImg.alt = `Cartão VIP ${card.number}`;
    cardImg.src = cardImgUrl;
    cardImg.style.width = '100%';
    cardImg.style.borderRadius = '12px';
    cardImg.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)';
    cardImg.style.border = '1px solid #ffffff22';

    const dlCardBtn = node('a', 'primary dl-card-btn', `⬇️ Baixar Cartão PNG (${card.number})`);
    dlCardBtn.href = cardImgUrl;
    dlCardBtn.download = `${card.number}-CARTAO-VIP.png`;
    dlCardBtn.style.textAlign = 'center';
    dlCardBtn.style.padding = '8px 12px';
    dlCardBtn.style.fontSize = '13px';
    dlCardBtn.style.marginTop = '4px';

    cardCol.append(cardTitle, cardImg, dlCardBtn);

    // Lado Direito: Imagem do QR Code isolado
    const qrCol = node('div');
    qrCol.style.flex = '0 0 auto';
    qrCol.style.width = '210px';
    qrCol.style.background = '#ffffff';
    qrCol.style.borderRadius = '14px';
    qrCol.style.padding = '14px';
    qrCol.style.display = 'flex';
    qrCol.style.flexDirection = 'column';
    qrCol.style.alignItems = 'center';
    qrCol.style.justifyContent = 'space-between';
    qrCol.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)';
    qrCol.style.border = '1.5px solid #ff7b4b';

    const qrHeader = node('div');
    qrHeader.style.textAlign = 'center';
    qrHeader.style.marginBottom = '6px';
    const qrLabel = node('div', '', 'QR CODE DO CARTÃO');
    qrLabel.style.fontSize = '11px';
    qrLabel.style.fontWeight = '900';
    qrLabel.style.color = '#ff7b4b';
    qrLabel.style.letterSpacing = '0.5px';
    const qrNum = node('div', '', card.number);
    qrNum.style.fontSize = '15px';
    qrNum.style.fontWeight = '800';
    qrNum.style.color = '#111111';
    qrHeader.append(qrLabel, qrNum);

    const qrImg = node('img');
    qrImg.alt = `QR Code ${card.number}`;
    qrImg.src = qrImgUrl;
    qrImg.style.width = '160px';
    qrImg.style.height = '160px';
    qrImg.style.display = 'block';
    qrImg.style.margin = '4px 0';

    const dlQrBtn = node('a', '', `⬇️ Baixar QR (SVG)`);
    dlQrBtn.href = qrImgUrl;
    dlQrBtn.download = `${card.number}-QR.svg`;
    dlQrBtn.style.display = 'inline-block';
    dlQrBtn.style.width = '100%';
    dlQrBtn.style.textAlign = 'center';
    dlQrBtn.style.padding = '6px 10px';
    dlQrBtn.style.background = '#1a1824';
    dlQrBtn.style.color = '#ffffff';
    dlQrBtn.style.borderRadius = '8px';
    dlQrBtn.style.fontSize = '12px';
    dlQrBtn.style.fontWeight = '700';
    dlQrBtn.style.textDecoration = 'none';

    qrCol.append(qrHeader, qrImg, dlQrBtn);

    rowWrap.append(cardCol, qrCol);
    item.append(rowWrap);
    target.append(item);
  }
  $('issuedActions').hidden = cards.length === 0;
  $('issuedCount').textContent = `${cards.length} cartão(ões) completo(s) gerado(s) com QR code individual salvo(s) no banco.`;
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
  const isCardActive = card.active !== false && card.active !== 0;
  if (card.status === 'issued' && !card.expired && isCardActive) {
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
    let errReason = 'Este cartão venceu. Não libere a entrada.';
    if (!isCardActive) {
      errReason = 'Este cartão está INATIVADO pelo administrador. Não libere a entrada.';
    } else if (card.status === 'redeemed') {
      errReason = 'Este QR já foi utilizado. Não libere uma segunda entrada.';
    }
    panel.append(node('p', 'message error', errReason));
  }

  if (session?.role === 'admin') {
    const editBtn = node('button', '', '✏️ Editar / Reativar Cartão');
    editBtn.type = 'button';
    editBtn.style.padding = '8px 14px';
    editBtn.style.fontSize = '13px';
    editBtn.style.marginTop = '12px';
    editBtn.style.background = '#281a33';
    editBtn.style.borderColor = '#bd468a';
    editBtn.style.color = '#ff9e73';
    editBtn.style.fontWeight = '700';
    editBtn.title = `Editar validade e ativação do cartão ${card.number}`;
    editBtn.addEventListener('click', () => openCardEdit(card));
    panel.append(editBtn);
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
  const valid = card.status === 'issued' && !card.expired && card.active !== false && card.active !== 0;
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
$('cancelUserEditBtn').addEventListener('click', resetUserForm);
$('userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (session?.role !== 'admin') return;
  const editId = $('userEditId').value;
  const password = $('newPassword').value;
  const confirm = $('confirmPassword').value;

  if (password || confirm || !editId) {
    if (password !== confirm) {
      notice('As senhas não coincidem.', 'error');
      return;
    }
    if (password && password.length < 12) {
      notice('A senha deve ter no mínimo 12 caracteres.', 'error');
      return;
    }
  }

  const role = $('newRole').value;
  const button = $('userSubmitBtn') || event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (editId) {
      const payload = {
        role,
        active: $('userActive').value === '1',
      };
      if (password) {
        payload.password = password;
      }
      if (role === 'admin' && !window.confirm('Confirmar alteração de permissão para Administrador?')) {
        button.disabled = false;
        return;
      }
      await api(`users/${editId}`, {method: 'PATCH', body: payload});
      notice('Usuário atualizado com sucesso.', 'success');
      resetUserForm();
      await refreshUsers();
    } else {
      if (!password) {
        notice('Informe uma senha inicial.', 'error');
        button.disabled = false;
        return;
      }
      if (role === 'admin' && !window.confirm('Este usuário terá acesso completo, inclusive emissão de cartões e cadastro de outros administradores. Continuar?')) {
        button.disabled = false;
        return;
      }
      await api('users', {method: 'POST', body: {username: $('newUsername').value.trim(), password, role}});
      resetUserForm();
      usersPage = 1;
      await refreshUsers();
      notice('Usuário cadastrado com sucesso. Informe a senha inicial por um canal privado.', 'success');
    }
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
window.addEventListener('pagehide', () => {
  stopCamera();
  stopBarCamera();
});

// =============================================================
// SUB-ABA CARTÕES CONSUMO & MODAL DE CONSUMO DO CARTÃO
// =============================================================
let cardsSubTab = 'recent';
let consumptionCardsPage = 1;
let consumptionCardsSearchTimer = null;

function switchCardsSubTab(tab) {
  cardsSubTab = tab;
  const isRecent = tab === 'recent';
  $('cardsSubNavRecent')?.classList.toggle('primary', isRecent);
  $('cardsSubNavConsumption')?.classList.toggle('primary', !isRecent);
  if ($('cardsRecentSubPanel')) $('cardsRecentSubPanel').hidden = !isRecent;
  if ($('cardsConsumptionSubPanel')) $('cardsConsumptionSubPanel').hidden = isRecent;
  if (!isRecent) {
    refreshConsumptionCards().catch((e) => notice(e.message, 'error'));
  }
}

$('cardsSubNavRecent')?.addEventListener('click', () => switchCardsSubTab('recent'));
$('cardsSubNavConsumption')?.addEventListener('click', () => switchCardsSubTab('consumption'));

async function refreshConsumptionCards() {
  const q = ($('consumptionSearch')?.value || '').trim();
  const data = await api(`bar/reports/consumption?page=${consumptionCardsPage}&page_size=20&q=${encodeURIComponent(q)}`);
  const tbody = $('consumptionCardsBody');
  if (!tbody) return;
  tbody.replaceChildren();

  const items = data.items || [];
  for (const item of items) {
    const tr = node('tr');

    const tdCard = node('td', '', item.card_number);
    tdCard.style.fontFamily = 'monospace';
    tdCard.style.fontWeight = '700';

    const tdOrigin = node('td', '', item.origin_name || '—');

    const tdTotal = node('td', '', formatMoney(item.total_spent));
    tdTotal.style.color = '#8be5b7';
    tdTotal.style.fontWeight = '800';

    const tdCount = node('td', '', `${item.order_count} pedido(s)`);

    const tdLast = node('td', '', formatDateTime(item.last_order_at));
    tdLast.style.fontSize = '13px';
    tdLast.style.color = '#ccc';

    const tdItems = node('td', '', item.items_summary || '—');
    tdItems.style.fontSize = '12px';
    tdItems.style.color = '#ff9e73';
    tdItems.style.maxWidth = '260px';

    const tdActions = node('td');
    const viewBtn = node('button', 'primary', '🍸 Ver Detalhes');
    viewBtn.type = 'button';
    viewBtn.style.padding = '5px 11px';
    viewBtn.style.fontSize = '12px';
    viewBtn.addEventListener('click', () => openCardConsumption(item.card_number));
    tdActions.append(viewBtn);

    tr.append(tdCard, tdOrigin, tdTotal, tdCount, tdLast, tdItems, tdActions);
    tbody.append(tr);
  }

  if (!items.length) {
    const tr = node('tr');
    const td = node('td', '', 'Nenhum cartão com consumo registrado até o momento.');
    td.colSpan = 7;
    td.style.textAlign = 'center';
    td.style.padding = '24px';
    td.style.color = '#9a94a6';
    tr.append(td);
    tbody.append(tr);
  }

  if ($('consumptionPage')) $('consumptionPage').textContent = `Página ${data.page} de ${data.pages || 1}`;
  if ($('consumptionPrev')) $('consumptionPrev').disabled = data.page <= 1;
  if ($('consumptionNext')) $('consumptionNext').disabled = data.page >= (data.pages || 1);
}

$('consumptionSearch')?.addEventListener('input', () => {
  clearTimeout(consumptionCardsSearchTimer);
  consumptionCardsSearchTimer = setTimeout(() => {
    consumptionCardsPage = 1;
    refreshConsumptionCards().catch((e) => notice(e.message, 'error'));
  }, 250);
});

$('refreshConsumptionBtn')?.addEventListener('click', () => {
  refreshConsumptionCards().catch((e) => notice(e.message, 'error'));
});

$('consumptionPrev')?.addEventListener('click', () => {
  if (consumptionCardsPage > 1) {
    consumptionCardsPage--;
    refreshConsumptionCards().catch((e) => notice(e.message, 'error'));
  }
});

$('consumptionNext')?.addEventListener('click', () => {
  consumptionCardsPage++;
  refreshConsumptionCards().catch((e) => notice(e.message, 'error'));
});

async function openCardConsumption(cardIdentifier) {
  const modal = $('cardConsumptionModal');
  const title = $('modalCardTitle');
  const subtitle = $('modalCardSubtitle');
  const content = $('modalConsumptionContent');
  if (!modal || !content) return;

  modal.hidden = false;
  title.textContent = `🍸 Consumo — ${cardIdentifier}`;
  subtitle.textContent = 'Carregando detalhes do consumo...';
  content.innerHTML = '<div style="text-align:center;padding:36px;color:#aaa">Carregando dados do consumo no bar...</div>';

  try {
    const data = await api(`bar/card/${encodeURIComponent(cardIdentifier)}`);
    const card = data.card;
    title.textContent = `🍸 Consumo — Cartão ${card.number}`;
    const statusTxt = card.status === 'redeemed' ? 'Entrada confirmada' : (card.expired ? 'Vencido' : 'Válido');
    subtitle.textContent = `Origem: ${card.origin_name || 'VIBZ'} • Status: ${statusTxt}${card.wristband ? ` • Pulseira: ${card.wristband}` : ''}`;

    let html = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px">
        <div style="background:#1c1929;border:1px solid #3c344d;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;color:#a8a0b0;text-transform:uppercase;font-weight:700">Total Consumido</span>
          <span style="font-size:24px;font-weight:900;color:#8be5b7">${formatMoney(data.total_spent)}</span>
        </div>
        <div style="background:#1c1929;border:1px solid #3c344d;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;color:#a8a0b0;text-transform:uppercase;font-weight:700">Qtd. de Pedidos</span>
          <span style="font-size:24px;font-weight:900;color:#fff">${data.total_orders} pedido(s)</span>
        </div>
        <div style="background:#1c1929;border:1px solid #3c344d;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;color:#a8a0b0;text-transform:uppercase;font-weight:700">Entrada na Portaria</span>
          <span style="font-size:14px;font-weight:700;color:#fff;margin-top:6px">${card.redeemed_at ? formatDateTime(card.redeemed_at) : 'Ainda não confirmada'}</span>
        </div>
      </div>
    `;

    if (data.orders.length === 0) {
      html += `
        <div style="background:#1a1726;border:1px dashed #4b425d;border-radius:14px;padding:32px;text-align:center;margin-top:10px">
          <div style="font-size:36px;margin-bottom:8px">🍸</div>
          <h4 style="margin:0 0 6px 0;font-size:16px;color:#fff">Nenhum consumo registrado no bar</h4>
          <p style="margin:0 0 16px 0;font-size:13px;color:#9b95a8">Este cartão ainda não realizou pedidos no bar do evento.</p>
          <button id="modalGoToBarPdv" type="button" class="primary" style="padding:9px 18px;font-size:13px">🛒 Lançar pedido para este cartão no Bar</button>
        </div>
      `;
    } else {
      if (data.summary_items && data.summary_items.length > 0) {
        html += `
          <div style="margin-bottom:20px">
            <h4 style="margin:0 0 10px 0;font-size:15px;color:#ff9e73">📊 Resumo Consolidado de Bebidas</h4>
            <div style="background:#100e18;border:1px solid #362e43;border-radius:10px;overflow:hidden">
              <table style="width:100%;margin:0;min-width:unset">
                <thead>
                  <tr style="background:#1a1626">
                    <th style="padding:8px 12px">Bebida</th>
                    <th style="padding:8px 12px">Formato</th>
                    <th style="padding:8px 12px;text-align:center">Qtd Total</th>
                    <th style="padding:8px 12px;text-align:right">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.summary_items.map(it => `
                    <tr>
                      <td style="padding:8px 12px;font-weight:700;color:#fff">${it.drink_name}</td>
                      <td style="padding:8px 12px;color:#aaa">${it.dosage}</td>
                      <td style="padding:8px 12px;text-align:center;font-weight:800;color:#ff9e73">${it.total_qty}</td>
                      <td style="padding:8px 12px;text-align:right;font-weight:800;color:#8be5b7">${formatMoney(it.total_subtotal)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }

      html += `
        <div>
          <h4 style="margin:0 0 10px 0;font-size:15px;color:#fff">🧾 Histórico Cronológico de Pedidos</h4>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${data.orders.map(ord => `
              <div style="background:#181524;border:1px solid #3d354b;border-radius:12px;padding:14px">
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2d2639;padding-bottom:8px;margin-bottom:8px;flex-wrap:wrap;gap:8px">
                  <div>
                    <strong style="color:#fff;font-size:14px">Pedido #${ord.id}</strong>
                    <span style="color:#a8a0b0;font-size:12px;margin-left:8px">🕒 ${formatDateTime(ord.created_at)}</span>
                    <span style="color:#a8a0b0;font-size:12px;margin-left:8px">• Atendente: <strong style="color:#ff9e73">${ord.operator_username || 'bar'}</strong></span>
                  </div>
                  <span style="font-size:15px;font-weight:800;color:#8be5b7">${formatMoney(ord.total_amount)}</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px">
                  ${(ord.items || []).map(it => `
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:3px 0">
                      <span style="color:#e4e0ea"><strong style="color:#ff9e73">${it.quantity}x</strong> ${it.drink_name} <small style="color:#8e889b">(${it.dosage})</small></span>
                      <span style="color:#ccc;font-size:12px">${formatMoney(it.unit_price)} un <strong style="color:#fff;margin-left:6px">${formatMoney(it.subtotal)}</strong></span>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    content.innerHTML = html;

    $('modalGoToBarPdv')?.addEventListener('click', async () => {
      closeConsumptionModal();
      switchTab('bar');
      switchBarSubTab('pdv');
      await findBarCard(card.number);
    });

  } catch (err) {
    content.innerHTML = `<div style="color:#ff8790;padding:24px;text-align:center">Erro ao carregar consumo: ${err.message}</div>`;
  }
}

function closeConsumptionModal() {
  const modal = $('cardConsumptionModal');
  if (modal) modal.hidden = true;
}

$('closeConsumptionModal')?.addEventListener('click', closeConsumptionModal);
$('cardConsumptionModal')?.addEventListener('click', (e) => {
  if (e.target === $('cardConsumptionModal')) closeConsumptionModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('cardConsumptionModal') && !$('cardConsumptionModal').hidden) {
    closeConsumptionModal();
  }
});

function openCardEdit(card) {
  if (!card) return;
  const modal = $('cardEditModal');
  if (!modal) return;
  $('editCardToken').value = card.token || '';
  $('editCardNumber').value = card.number || '';
  $('editCardOrigin').value = card.origin_name || 'VIBZ TOURIST PASS';
  $('editCardActive').value = (card.active === false || card.active === 0) ? '0' : '1';
  $('editCardValidUntil').value = card.valid_until || '';
  $('editCardStatus').value = card.status || 'issued';
  modal.hidden = false;
}

function closeCardEditModal() {
  const modal = $('cardEditModal');
  if (modal) modal.hidden = true;
}

$('closeEditCardModal')?.addEventListener('click', closeCardEditModal);
$('cancelCardEditBtn')?.addEventListener('click', closeCardEditModal);
$('clearEditCardDateBtn')?.addEventListener('click', () => {
  $('editCardValidUntil').value = '';
});
$('cardEditModal')?.addEventListener('click', (e) => {
  if (e.target === $('cardEditModal')) closeCardEditModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('cardEditModal') && !$('cardEditModal').hidden) {
    closeCardEditModal();
  }
});

$('cardEditForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (session?.role !== 'admin') {
    notice('Apenas administradores podem editar cartões.', 'error');
    return;
  }
  const token = $('editCardToken').value;
  if (!token) return;
  const saveBtn = $('saveCardEditBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Salvando...';
  try {
    const activeVal = $('editCardActive').value === '1';
    const validUntilVal = $('editCardValidUntil').value.trim() || null;
    const statusVal = $('editCardStatus').value;
    const updated = await api(`cards/${encodeURIComponent(token)}`, {
      method: 'PATCH',
      body: {
        active: activeVal,
        valid_until: validUntilVal,
        status: statusVal,
      },
    });
    notice(`✓ Cartão ${updated.number} atualizado com sucesso!`, 'success');
    closeCardEditModal();
    if ($('cardResult') && !$('cardResult').hidden && $('cardResult').textContent.includes(updated.number)) {
      renderCard(updated);
    }
    await Promise.allSettled([refreshCards(), refreshScannedCards(), refreshReports()]);
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Salvar Alterações';
  }
});

// =============================================================
// MÓDULO BAR & CARDÁPIO DE BEBIDAS
// =============================================================
let currentDrinks = [];
let currentBarCart = [];
let currentBarCard = null;
let barSubTab = 'pdv';
let consumptionPage = 1;
let consumptionQuery = '';


async function initBarModule() {
  const dateInput = $('barDailyDate');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }
  switchBarSubTab(barSubTab || 'pdv');
  await refreshBarMenu();
}

function switchBarSubTab(name) {
  if (name !== 'pdv') stopBarCamera();
  if (name === 'menu') {
    switchTab('menu');
    return;
  }
  if (name === 'stock') {
    switchTab('stock');
    return;
  }
  barSubTab = name;
  const tabs = {
    pdv: $('barPdvView'),
    clients: $('barClientsView'),
    daily: $('barDailyView')
  };
  const btns = {
    pdv: $('barSubNavPdv'),
    menu: $('barSubNavMenu'),
    stock: $('barSubNavStock'),
    clients: $('barSubNavClients'),
    daily: $('barSubNavDaily')
  };
  for (const [k, el] of Object.entries(tabs)) {
    if (el) el.hidden = (k !== name);
  }
  for (const [k, btn] of Object.entries(btns)) {
    if (btn) btn.classList.toggle('active', k === name);
  }

  if (name === 'pdv') {
    renderCart();
    renderQuickMenu();
  } else if (name === 'clients') {
    consumptionPage = 1;
    refreshClientConsumption().catch((err) => notice(err.message, 'error'));
  } else if (name === 'daily') {
    refreshDailyBarReport().catch((err) => notice(err.message, 'error'));
  }
}

async function refreshBarMenu() {
  try {
    currentDrinks = await api('bar/drinks?active_only=false');
  } catch (err) {
    notice(`Erro ao carregar cardápio: ${err.message}`, 'error');
    return;
  }
  renderDrinksTable();
  renderQuickMenu();
  populateStockDropdowns();
}

function renderQuickMenu() {
  const grid = $('barQuickMenuGrid');
  const countBadge = $('barDrinksCountBadge');
  if (!grid) return;
  const activeDrinks = currentDrinks.filter((d) => d.active);
  if (countBadge) countBadge.textContent = `${activeDrinks.length} opções disponíveis`;
  grid.replaceChildren();

  for (const drink of activeDrinks) {
    const card = node('div', 'drink-card');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const nameEl = node('div', 'drink-card-name', drink.name);
    
    const footer = node('div', 'drink-card-footer');
    const badge = node('span', `dosage-badge dosage-${drink.dosage}`, drink.dosage);
    const price = node('span', 'drink-card-price', formatMoney(drink.price));
    footer.append(badge, price);

    card.append(nameEl, footer);
    card.addEventListener('click', () => {
      addToCart(drink);
    });
    grid.append(card);
  }

  if (!activeDrinks.length) {
    grid.append(node('p', 'hint', 'Nenhuma bebida ativa no momento. Cadastre opções na aba "Cardápio".'));
  }
}

function renderDrinksTable() {
  const body = $('drinksBody');
  if (!body) return;
  body.replaceChildren();

  const query = normalizeStr($('menuSearchInput')?.value || '');
  const filtered = currentDrinks.filter((d) => !query || normalizeStr(d.name).includes(query) || normalizeStr(d.dosage).includes(query));

  for (const drink of filtered) {
    const row = node('tr');

    const nameCell = node('td', '', drink.name);
    const dosageCell = node('td');
    dosageCell.append(node('span', `dosage-badge dosage-${drink.dosage}`, drink.dosage));
    const priceCell = node('td', '', formatMoney(drink.price));
    const costCell = node('td', '', formatMoney(drink.cost_price || 0));

    let stockBadgeClass = 'valid';
    let stockStatusText = `${drink.stock_quantity ?? 0} un.`;
    if ((drink.stock_quantity ?? 0) <= 0) {
      stockBadgeClass = 'used';
      stockStatusText = '0 un. (Zerado)';
    } else if ((drink.stock_quantity ?? 0) <= (drink.min_stock ?? 10)) {
      stockBadgeClass = 'revoked';
      stockStatusText = `${drink.stock_quantity} un. (Baixo)`;
    }
    const stockCell = node('td');
    stockCell.append(node('span', `badge ${stockBadgeClass}`, stockStatusText));

    const statusBadge = node('span', `badge ${drink.active ? 'valid' : 'used'}`, drink.active ? 'Ativo' : 'Inativo');
    const statusCell = node('td');
    statusCell.append(statusBadge);

    const actionWrap = node('div', 'button-row');
    actionWrap.style.margin = '0';
    actionWrap.style.gap = '6px';
    actionWrap.style.alignItems = 'center';

    const editBtn = node('button', '', '✏️ Editar');
    editBtn.type = 'button';
    editBtn.style.padding = '4px 8px';
    editBtn.style.fontSize = '12px';
    editBtn.addEventListener('click', () => editDrink(drink));

    const entryBtn = node('button', 'primary', '+ Entrada');
    entryBtn.type = 'button';
    entryBtn.style.padding = '4px 8px';
    entryBtn.style.fontSize = '12px';
    entryBtn.addEventListener('click', () => {
      switchTab('stock');
      openStockEntryModal(drink.id);
    });

    const toggleBtn = node('button', '', drink.active ? 'Desativar' : 'Ativar');
    toggleBtn.type = 'button';
    toggleBtn.style.padding = '4px 8px';
    toggleBtn.style.fontSize = '12px';
    toggleBtn.addEventListener('click', async () => {
      try {
        await api(`bar/drinks/${drink.id}`, { method: 'PATCH', body: { active: !drink.active } });
        notice(`Bebida "${drink.name}" ${drink.active ? 'desativada' : 'ativada'}.`, 'success');
        await refreshBarMenu();
      } catch (err) {
        notice(err.message, 'error');
      }
    });

    const delBtn = node('button', 'danger-btn', '🗑️ Excluir');
    delBtn.type = 'button';
    delBtn.style.padding = '4px 8px';
    delBtn.style.fontSize = '12px';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`Deseja realmente excluir ou desativar a bebida "${drink.name}"?`)) return;
      try {
        await api(`bar/drinks/${drink.id}`, { method: 'DELETE' });
        notice(`Bebida "${drink.name}" removida do cardápio.`, 'success');
        await refreshBarMenu();
      } catch (err) {
        notice(err.message, 'error');
      }
    });

    actionWrap.append(editBtn, entryBtn, toggleBtn, delBtn);
    const actionCell = node('td');
    actionCell.append(actionWrap);

    row.append(nameCell, dosageCell, priceCell, costCell, stockCell, statusCell, actionCell);
    body.append(row);
  }

  if (!filtered.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhuma bebida encontrada.');
    cell.colSpan = 7;
    row.append(cell);
    body.append(row);
  }
}

function editDrink(drink) {
  $('drinkEditId').value = drink.id;
  $('drinkName').value = drink.name;
  $('drinkPrice').value = drink.price;
  $('drinkCostPrice').value = drink.cost_price || 0;
  $('drinkDosage').value = drink.dosage;
  $('drinkStock').value = drink.stock_quantity ?? 50;
  $('drinkMinStock').value = drink.min_stock ?? 10;
  $('drinkEditBanner').style.display = 'flex';
  $('drinkFormModeTitle').textContent = `✏️ Modo Edição: ${drink.name}`;
  $('drinkFormTitle').textContent = `Editar Bebida: ${drink.name}`;
  $('saveDrinkBtn').textContent = 'Salvar alterações';
  $('cancelEditDrinkBtn').style.display = 'inline-block';
  $('drinkName').focus();
  window.scrollTo({ top: $('drinkForm').offsetTop - 60, behavior: 'smooth' });
}

function resetDrinkForm() {
  $('drinkEditId').value = '';
  $('drinkForm').reset();
  $('drinkEditBanner').style.display = 'none';
  $('drinkFormTitle').textContent = 'Cadastrar Nova Bebida';
  $('saveDrinkBtn').textContent = 'Salvar bebida';
  $('cancelEditDrinkBtn').style.display = 'none';
}

// -------------------------------------------------------------
// GESTÃO DE ESTOQUE & RELATÓRIOS DO ESTOQUE
// -------------------------------------------------------------
let currentStockOverview = null;
let stockMovementsPage = 1;

async function refreshStock() {
  try {
    currentStockOverview = await api('stock/overview');
    renderStockOverview();
    populateStockDropdowns();
    await refreshStockMovements();
  } catch (err) {
    notice(`Erro ao carregar estoque: ${err.message}`, 'error');
  }
}

function populateStockDropdowns() {
  const drinks = currentStockOverview?.items || currentDrinks || [];
  const entrySelect = $('stockEntryDrink');
  const adjustSelect = $('stockAdjustDrink');
  const filterSelect = $('stockDrinkFilter');

  if (entrySelect) {
    const curVal = entrySelect.value;
    entrySelect.replaceChildren();
    const newOpt = node('option', '', '✨ + Cadastrar Nova Bebida no Cardápio e Estoque...');
    newOpt.value = '__new__';
    entrySelect.append(newOpt);

    const group = node('optgroup');
    group.label = 'Bebidas Cadastradas';
    for (const d of drinks) {
      const opt = node('option', '', `${d.name} (${d.dosage}) · Atual: ${d.stock_quantity} un.`);
      opt.value = d.id;
      group.append(opt);
    }
    entrySelect.append(group);
    if (curVal && curVal !== '__new__') entrySelect.value = curVal;
    else if (drinks.length > 0 && curVal !== '__new__') entrySelect.value = drinks[0].id;
  }

  if (adjustSelect) {
    const curVal = adjustSelect.value;
    adjustSelect.replaceChildren();
    for (const d of drinks) {
      const opt = node('option', '', `${d.name} (${d.dosage}) · Atual: ${d.stock_quantity} un.`);
      opt.value = d.id;
      adjustSelect.append(opt);
    }
    if (curVal) adjustSelect.value = curVal;
  }

  if (filterSelect) {
    const curVal = filterSelect.value;
    filterSelect.replaceChildren();
    const allOpt = node('option', '', 'Todas as bebidas');
    allOpt.value = 'all';
    filterSelect.append(allOpt);
    for (const d of drinks) {
      const opt = node('option', '', `${d.name} (${d.dosage})`);
      opt.value = d.id;
      filterSelect.append(opt);
    }
    if (curVal) filterSelect.value = curVal;
  }
}

function renderStockOverview() {
  if (!currentStockOverview) return;
  const kpis = currentStockOverview.kpis;
  $('kpiStockTotalItems').textContent = `${kpis.total_stock_items} un.`;
  $('kpiStockTotalDrinks').textContent = `${kpis.total_drinks_count} bebidas ativas`;
  $('kpiStockLowCount').textContent = kpis.low_stock_count;
  $('kpiStockOutCount').textContent = kpis.out_of_stock_count;
  $('kpiStockSaleValue').textContent = formatMoney(kpis.total_sale_value);
  $('kpiStockCostValue').textContent = `Custo: ${formatMoney(kpis.total_cost_value)}`;

  const body = $('stockOverviewBody');
  if (!body) return;
  body.replaceChildren();

  for (const item of currentStockOverview.items) {
    const row = node('tr');

    let badgeClass = 'valid';
    let statusText = 'Normal';
    if (item.status === 'zerado') {
      badgeClass = 'used';
      statusText = 'Zerado / Esgotado';
    } else if (item.status === 'baixo') {
      badgeClass = 'revoked';
      statusText = 'Estoque Baixo';
    }

    const actionCell = node('td');
    actionCell.style.display = 'flex';
    actionCell.style.gap = '6px';

    const entryBtn = node('button', 'primary', '+ Entrada');
    entryBtn.type = 'button';
    entryBtn.style.padding = '4px 8px';
    entryBtn.style.fontSize = '12px';
    entryBtn.onclick = () => openStockEntryModal(item.id);

    const adjustBtn = node('button', '', 'Ajustar');
    adjustBtn.type = 'button';
    adjustBtn.style.padding = '4px 8px';
    adjustBtn.style.fontSize = '12px';
    adjustBtn.onclick = () => openStockAdjustModal(item.id, item.stock_quantity);

    actionCell.append(entryBtn, adjustBtn);

    const statusBadgeCell = node('td');
    statusBadgeCell.append(node('span', `badge ${badgeClass}`, statusText));

    row.append(
      node('td', '', item.name),
      node('td', '', item.dosage),
      node('td', '', `${item.stock_quantity} un.`),
      node('td', '', `${item.min_stock} un.`),
      statusBadgeCell,
      node('td', '', formatMoney(item.price)),
      node('td', '', formatMoney(item.total_sale_value)),
      actionCell
    );
    body.append(row);
  }

  if (!currentStockOverview.items.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhuma bebida cadastrada no estoque.');
    cell.colSpan = 8;
    row.append(cell);
    body.append(row);
  }
}

async function refreshStockMovements() {
  const period = $('stockPeriodFilter')?.value || '30';
  const drinkId = $('stockDrinkFilter')?.value;
  const movementType = $('stockTypeFilter')?.value || 'all';

  let url = `stock/movements?page=${stockMovementsPage}&page_size=25&period=${period}&movement_type=${movementType}`;
  if (drinkId && drinkId !== 'all') {
    url += `&drink_id=${drinkId}`;
  }

  try {
    const result = await api(url);
    const body = $('stockMovementsBody');
    if (!body) return;
    body.replaceChildren();

    for (const mov of result.items) {
      const row = node('tr');

      let typeBadgeClass = 'valid';
      let typeName = 'Entrada 📥';
      let qtyDisplay = `+${mov.quantity}`;
      if (mov.movement_type === 'venda') {
        typeBadgeClass = 'revoked';
        typeName = 'Venda Bar 🛒';
        qtyDisplay = `${mov.quantity}`;
      } else if (mov.movement_type === 'ajuste') {
        typeBadgeClass = 'used';
        typeName = 'Ajuste ⚖️';
        qtyDisplay = mov.quantity > 0 ? `+${mov.quantity}` : `${mov.quantity}`;
      }

      const typeBadge = node('span', `badge ${typeBadgeClass}`, typeName);
      const typeCell = node('td');
      typeCell.append(typeBadge);

      row.append(
        node('td', '', formatDateTime(mov.created_at)),
        node('td', '', `${mov.drink_name || 'Bebida'} (${mov.dosage || ''})`),
        typeCell,
        node('td', '', qtyDisplay),
        node('td', '', `${mov.previous_stock} ➔ ${mov.new_stock}`),
        node('td', '', mov.reason || '—'),
        node('td', '', mov.operator_username || 'Sistema')
      );
      body.append(row);
    }

    if (!result.items.length) {
      const row = node('tr');
      const cell = node('td', '', 'Nenhuma movimentação de estoque encontrada para os filtros selecionados.');
      cell.colSpan = 7;
      row.append(cell);
      body.append(row);
    }

    renderPager('stockMovements', result);
  } catch (err) {
    notice(`Erro ao carregar movimentações: ${err.message}`, 'error');
  }
}

function setStockEntryMode(mode) {
  const isNew = mode === 'new';
  if ($('stockEntryModeNew')) $('stockEntryModeNew').checked = isNew;
  if ($('stockEntryModeExisting')) $('stockEntryModeExisting').checked = !isNew;
  if ($('stockEntryExistingGroup')) $('stockEntryExistingGroup').style.display = isNew ? 'none' : 'block';
  if ($('stockEntryNewGroup')) $('stockEntryNewGroup').style.display = isNew ? 'block' : 'none';
  if (isNew) {
    $('stockEntryNewName')?.focus();
  } else {
    $('stockEntryQty')?.focus();
  }
}

function openStockEntryModal(drinkId = null) {
  $('stockEntryModal').style.display = 'block';
  if (drinkId === '__new__') {
    setStockEntryMode('new');
  } else {
    setStockEntryMode('existing');
    if (drinkId) {
      $('stockEntryDrink').value = drinkId;
    }
    $('stockEntryQty').focus();
  }
  $('stockEntryModal').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openStockAdjustModal(drinkId = null, currentQty = 0) {
  $('stockAdjustModal').style.display = 'block';
  if (drinkId) {
    $('stockAdjustDrink').value = drinkId;
  }
  $('stockAdjustQty').value = currentQty;
  $('stockAdjustQty').focus();
  $('stockAdjustModal').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function exportStockCsv() {
  if (!currentStockOverview || !currentStockOverview.items.length) {
    notice('Nenhum dado de estoque para exportar.', 'error');
    return;
  }
  let csv = 'ID,Bebida,Dosagem,Estoque_Atual,Estoque_Minimo,Status,Preco_Venda,Preco_Custo,Valor_Total_Venda,Valor_Total_Custo\n';
  for (const it of currentStockOverview.items) {
    csv += `"${it.id}","${it.name}","${it.dosage}",${it.stock_quantity},${it.min_stock},"${it.status}",${it.price},${it.cost_price || 0},${it.total_sale_value},${it.total_cost_value}\n`;
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `relatorio-estoque-vibz-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function addToCart(drink) {
  const existing = currentBarCart.find((it) => it.drink_id === drink.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    currentBarCart.push({
      drink_id: drink.id,
      name: drink.name,
      dosage: drink.dosage,
      price: drink.price,
      quantity: 1
    });
  }
  renderCart();
}

function updateCartItemQty(drinkId, delta) {
  const idx = currentBarCart.findIndex((it) => it.drink_id === drinkId);
  if (idx < 0) return;
  currentBarCart[idx].quantity += delta;
  if (currentBarCart[idx].quantity <= 0) {
    currentBarCart.splice(idx, 1);
  }
  renderCart();
}

function renderCart() {
  const container = $('barCartItems');
  const emptyMsg = $('barCartEmpty');
  const totalBox = $('barCartTotalBox');
  const totalEl = $('barCartTotal');
  if (!container) return;

  container.replaceChildren();

  if (!currentBarCart.length) {
    if (emptyMsg) emptyMsg.style.display = 'block';
    if (totalBox) totalBox.style.display = 'none';
    return;
  }

  if (emptyMsg) emptyMsg.style.display = 'none';
  if (totalBox) totalBox.style.display = 'block';

  let total = 0;
  for (const item of currentBarCart) {
    const subtotal = item.price * item.quantity;
    total += subtotal;

    const row = node('div', 'cart-item-row');

    const info = node('div');
    info.style.flex = '1';
    const title = node('strong', '', item.name);
    title.style.display = 'block';
    title.style.fontSize = '14px';
    const sub = node('span', 'hint', `${item.dosage.toUpperCase()} · ${formatMoney(item.price)} un.`);
    sub.style.margin = '0';
    info.append(title, sub);

    const controls = node('div');
    controls.style.display = 'flex';
    controls.style.alignItems = 'center';
    controls.style.gap = '6px';

    const minusBtn = node('button', 'cart-qty-btn', '−');
    minusBtn.type = 'button';
    minusBtn.addEventListener('click', () => updateCartItemQty(item.drink_id, -1));

    const qtySpan = node('span', '', String(item.quantity));
    qtySpan.style.minWidth = '22px';
    qtySpan.style.textAlign = 'center';
    qtySpan.style.fontWeight = '800';

    const plusBtn = node('button', 'cart-qty-btn', '+');
    plusBtn.type = 'button';
    plusBtn.addEventListener('click', () => updateCartItemQty(item.drink_id, 1));

    controls.append(minusBtn, qtySpan, plusBtn);

    const priceBox = node('div');
    priceBox.style.textAlign = 'right';
    priceBox.style.minWidth = '80px';
    const subtotalEl = node('strong', '', formatMoney(subtotal));
    subtotalEl.style.color = '#8be5b7';
    subtotalEl.style.fontSize = '14px';
    priceBox.append(subtotalEl);

    const removeBtn = node('button', 'text-button', '✕');
    removeBtn.type = 'button';
    removeBtn.title = 'Remover item';
    removeBtn.style.color = '#ff8790';
    removeBtn.style.padding = '0 4px';
    removeBtn.addEventListener('click', () => {
      const idx = currentBarCart.findIndex((it) => it.drink_id === item.drink_id);
      if (idx >= 0) currentBarCart.splice(idx, 1);
      renderCart();
    });

    row.append(info, controls, priceBox, removeBtn);
    container.append(row);
  }

  if (totalEl) totalEl.textContent = formatMoney(total);
}

// -------------------------------------------------------------
// Leitor de Câmera do Bar (PDV)
// -------------------------------------------------------------
let barCameraStream = null;
let barScanActive = false;
let barScanBusy = false;
let barLastFrame = 0;

function stopBarCamera() {
  barScanActive = false;
  if (barCameraStream) {
    try {
      barCameraStream.getTracks().forEach((track) => track.stop());
    } catch (_) {}
  }
  barCameraStream = null;
  const vid = $('barCamera');
  if (vid) {
    vid.srcObject = null;
    vid.hidden = true;
  }
  const ph = $('barCameraPlaceholder');
  if (ph) {
    ph.hidden = false;
    ph.textContent = 'Câmera desligada';
  }
  const sec = $('barCameraSection');
  if (sec) sec.style.display = 'none';
  const toggleBtn = $('barToggleCameraBtn');
  if (toggleBtn) {
    toggleBtn.innerHTML = '📷 Ler com Câmera';
    toggleBtn.classList.add('primary');
  }
}

async function scanBarFrame(timestamp) {
  if (!barScanActive) return;
  requestAnimationFrame(scanBarFrame);
  if (barScanBusy || timestamp - barLastFrame < 180) return;
  const video = $('barCamera');
  if (!video || video.readyState < 2) return;

  barLastFrame = timestamp;
  barScanBusy = true;
  try {
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
    if (value && barScanActive) {
      stopBarCamera();
      await findBarCard(value);
      if (currentBarCard) playBling();
    }
  } catch (error) {
    notice(error.message, 'error');
    stopBarCamera();
  } finally {
    barScanBusy = false;
  }
}

async function startBarCamera() {
  const placeholder = $('barCameraPlaceholder');
  const sec = $('barCameraSection');
  const toggleBtn = $('barToggleCameraBtn');

  if (!navigator.mediaDevices?.getUserMedia) {
    const msg = 'A câmera exige HTTPS e permissão do navegador.';
    notice(msg, 'error');
    return;
  }

  stopBarCamera();
  if (sec) sec.style.display = 'block';
  if (placeholder) {
    placeholder.hidden = false;
    placeholder.textContent = 'Conectando câmera...';
  }
  if (toggleBtn) {
    toggleBtn.innerHTML = '⏹ Parar Câmera';
    toggleBtn.classList.remove('primary');
  }

  try {
    try {
      barCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (_) {
      barCameraStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }
    const video = $('barCamera');
    video.srcObject = barCameraStream;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.muted = true;
    video.hidden = false;
    if (placeholder) placeholder.hidden = true;
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.onloadedmetadata = () => resolve();
    });
    await video.play();
    barScanActive = true;
    requestAnimationFrame(scanBarFrame);
  } catch (error) {
    stopBarCamera();
    notice(`Não foi possível abrir a câmera: ${error.message}`, 'error');
  }
}

function toggleBarCamera() {
  if (barScanActive || barCameraStream) {
    stopBarCamera();
  } else {
    startBarCamera().catch((err) => notice(err.message, 'error'));
  }
}

async function findBarCard(val) {
  const raw = (val || $('barCardInput')?.value || '').trim();
  if (!raw) {
    notice('Digite o número do cartão ou escaneie o QR.', 'error');
    return;
  }
  try {
    const res = await api('bar/lookup', {
      method: 'POST',
      body: { qr: raw }
    });
    currentBarCard = res.card;
    if ($('barCardInput')) $('barCardInput').value = res.card.number;
    $('barCardStatusBox').style.display = 'block';
    const expText = res.card.expired ? ' · ⚠️ VENCIDO' : '';
    $('barCardNumber').textContent = `${res.card.number}${res.card.expired ? ' (Vencido)' : ''}`;
    $('barCardOrigin').textContent = `Origem: ${res.card.origin_name || 'VIBZ'} · Status: ${res.card.status === 'redeemed' ? 'Entrada confirmada' : 'Emitido'}${expText}`;
    $('barCardTotalSpent').textContent = `Total já consumido no bar: ${formatMoney(res.total_spent)}`;
    if (res.card.expired) {
      notice(`⚠️ Cartão ${res.card.number} identificado, porém está VENCIDO!`, 'error');
    } else {
      notice(`✓ Cartão ${res.card.number} identificado!`, 'success');
    }
  } catch (err) {
    currentBarCard = null;
    $('barCardStatusBox').style.display = 'none';
    notice(err.message, 'error');
  }
}

async function submitBarOrder() {
  if (!currentBarCard) {
    notice('Identifique o cartão do cliente antes de confirmar o consumo.', 'error');
    $('barCardInput')?.focus();
    return;
  }
  if (!currentBarCart.length) {
    notice('Selecione ao menos uma bebida no cardápio.', 'error');
    return;
  }
  let total = currentBarCart.reduce((sum, it) => sum + (it.price * it.quantity), 0);
  if (!window.confirm(`Confirmar venda no valor de ${formatMoney(total)} para o cartão ${currentBarCard.number}?`)) {
    return;
  }

  const btn = $('barSubmitOrderBtn');
  try {
    btn.disabled = true;
    const body = {
      card: currentBarCard.token,
      items: currentBarCart.map((it) => ({ drink_id: it.drink_id, quantity: it.quantity }))
    };
    const order = await api('bar/order', { method: 'POST', body });
    playBling();
    notice(`✓ Pedido #${order.id} lançado com sucesso para ${order.card_number}! Total: ${formatMoney(order.total_amount)}`, 'success');
    currentBarCart = [];
    renderCart();
    await findBarCard(currentBarCard.number);
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function refreshClientConsumption() {
  const query = $('clientConsumptionQuery')?.value.trim() || '';
  consumptionQuery = query;
  const result = await api(`bar/reports/consumption?page=${consumptionPage}&page_size=20&q=${encodeURIComponent(query)}`);
  const body = $('clientConsumptionBody');
  body.replaceChildren();

  for (const item of result.items) {
    const row = node('tr');

    const cardCell = node('td', '', item.card_number);
    const originCell = node('td', '', item.origin_name || 'VIBZ');
    const countCell = node('td', '', `${item.order_count} pedido(s)`);
    const totalCell = node('td');
    const totalStrong = node('strong', '', formatMoney(item.total_spent));
    totalStrong.style.color = '#8be5b7';
    totalCell.append(totalStrong);

    const itemsCell = node('td', '', item.items_summary || '—');
    itemsCell.style.maxWidth = '250px';
    itemsCell.style.fontSize = '13px';

    const lastOrderCell = node('td', '', formatDateTime(item.last_order_at));

    const actionCell = node('td');
    const detailsBtn = node('button', 'primary', 'Ver Extrato');
    detailsBtn.type = 'button';
    detailsBtn.style.padding = '5px 10px';
    detailsBtn.style.fontSize = '12px';
    detailsBtn.addEventListener('click', () => viewClientDetails(item.card_number));
    actionCell.append(detailsBtn);

    row.append(cardCell, originCell, countCell, totalCell, itemsCell, lastOrderCell, actionCell);
    body.append(row);
  }

  if (!result.items.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum consumo registrado com os critérios informados.');
    cell.colSpan = 7;
    row.append(cell);
    body.append(row);
  }

  renderPager('consumption', result);
}

async function viewClientDetails(cardIdentifier) {
  try {
    const data = await api(`bar/card/${encodeURIComponent(cardIdentifier)}`);
    const modal = $('clientDetailsModal');
    $('cdmCardNumber').textContent = `Extrato de Consumo — ${data.card.number}`;
    $('cdmOrigin').textContent = `Origem: ${data.card.origin_name || 'VIBZ'} · Status: ${data.card.status === 'redeemed' ? 'Entrada confirmada' : 'Emitido'}`;
    $('cdmTotalSpent').textContent = formatMoney(data.total_spent);
    $('cdmTotalOrders').textContent = String(data.total_orders);

    const body = $('cdmOrdersBody');
    body.replaceChildren();

    for (const ord of data.orders) {
      const row = node('tr');
      const dateCell = node('td', '', formatDateTime(ord.created_at));
      const opCell = node('td', '', ord.operator_username || 'Bar');
      
      const itemsCell = node('td');
      const itemsList = ord.items.map((i) => `${i.quantity}x ${i.drink_name} (${formatMoney(i.subtotal)})`).join(', ');
      itemsCell.textContent = itemsList;

      const totalCell = node('td');
      const totalStrong = node('strong', '', formatMoney(ord.total_amount));
      totalStrong.style.color = '#8be5b7';
      totalCell.append(totalStrong);

      row.append(dateCell, opCell, itemsCell, totalCell);
      body.append(row);
    }

    if (!data.orders.length) {
      const row = node('tr');
      const cell = node('td', '', 'Nenhum pedido registrado para este cartão.');
      cell.colSpan = 4;
      row.append(cell);
      body.append(row);
    }

    modal.style.display = 'block';
    window.scrollTo({ top: modal.offsetTop - 60, behavior: 'smooth' });
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function refreshDailyBarReport(dateVal) {
  const chosenDate = dateVal || $('barDailyDate')?.value || '';
  const result = await api(`bar/reports/daily?date=${encodeURIComponent(chosenDate)}`);

  $('barDailyCurrentDateLabel').textContent = `Data: ${new Date(result.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
  $('kpiBarRevenue').textContent = formatMoney(result.summary.total_revenue);
  $('kpiBarDrinks').textContent = String(result.summary.total_drinks_sold);
  $('kpiBarOrders').textContent = String(result.summary.order_count);
  $('kpiBarCustomers').textContent = String(result.summary.customer_count);

  const drinksBody = $('barDailyDrinksBody');
  drinksBody.replaceChildren();
  for (const item of result.drinks_breakdown) {
    const row = node('tr');
    row.append(
      node('td', '', item.drink_name),
      node('td', '', item.dosage.toUpperCase()),
      node('td', '', formatMoney(item.avg_unit_price)),
      node('td', '', String(item.quantity_sold)),
      node('td', '', formatMoney(item.total_revenue))
    );
    drinksBody.append(row);
  }
  if (!result.drinks_breakdown.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhuma venda registrada nesta data.');
    cell.colSpan = 5;
    row.append(cell);
    drinksBody.append(row);
  }

  const ordersBody = $('barDailyOrdersBody');
  ordersBody.replaceChildren();
  for (const ord of result.recent_orders) {
    const row = node('tr');
    const timeStr = ord.created_at ? formatDateTime(ord.created_at) : '—';
    row.append(
      node('td', '', timeStr),
      node('td', '', ord.card_number),
      node('td', '', ord.items_summary || '—'),
      node('td', '', formatMoney(ord.total_amount)),
      node('td', '', ord.operator_username || 'Bar')
    );
    ordersBody.append(row);
  }
  if (!result.recent_orders.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum pedido registrado nesta data.');
    cell.colSpan = 5;
    row.append(cell);
    ordersBody.append(row);
  }
}

// Event Listeners do Módulo Bar
$('barSubNavPdv')?.addEventListener('click', () => switchBarSubTab('pdv'));
$('barSubNavMenu')?.addEventListener('click', () => switchBarSubTab('menu'));
$('barSubNavClients')?.addEventListener('click', () => switchBarSubTab('clients'));
$('barSubNavDaily')?.addEventListener('click', () => switchBarSubTab('daily'));

$('barFindCardBtn')?.addEventListener('click', () => findBarCard());
$('barToggleCameraBtn')?.addEventListener('click', toggleBarCamera);
$('barStopCameraBtn')?.addEventListener('click', stopBarCamera);
$('barCardInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    findBarCard();
  }
});

$('barClearCartBtn')?.addEventListener('click', () => {
  currentBarCart = [];
  renderCart();
});
$('barSubmitOrderBtn')?.addEventListener('click', submitBarOrder);

$('drinkForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const editId = $('drinkEditId').value;
  const name = $('drinkName').value.trim();
  const price = parseFloat($('drinkPrice').value);
  const cost_price = parseFloat($('drinkCostPrice')?.value || '0');
  const dosage = $('drinkDosage').value;
  const stock_quantity = parseInt($('drinkStock')?.value || '50', 10);
  const min_stock = parseInt($('drinkMinStock')?.value || '10', 10);

  try {
    if (editId) {
      await api(`bar/drinks/${editId}`, {
        method: 'PATCH',
        body: { name, price, cost_price, dosage, stock_quantity, min_stock }
      });
      notice(`Bebida "${name}" atualizada com sucesso!`, 'success');
    } else {
      await api('bar/drinks', {
        method: 'POST',
        body: { name, price, cost_price, dosage, initial_stock: stock_quantity, min_stock }
      });
      notice(`Bebida "${name}" cadastrada com sucesso!`, 'success');
    }
    resetDrinkForm();
    await refreshBarMenu();
    if (!$('stockTab').hidden) await refreshStock();
  } catch (err) {
    notice(err.message, 'error');
  }
});
$('cancelEditDrinkBtn')?.addEventListener('click', resetDrinkForm);
$('cancelEditDrinkBannerBtn')?.addEventListener('click', resetDrinkForm);

$('stockEntryDrink')?.addEventListener('change', (e) => {
  if (e.target.value === '__new__') {
    setStockEntryMode('new');
  }
});
$('stockEntryModeExisting')?.addEventListener('change', () => setStockEntryMode('existing'));
$('stockEntryModeNew')?.addEventListener('change', () => setStockEntryMode('new'));

$('stockEntryForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const isNewMode = $('stockEntryModeNew')?.checked || $('stockEntryDrink')?.value === '__new__';
  const quantity = parseInt($('stockEntryQty').value, 10);
  const unit_cost = parseFloat($('stockEntryCost').value || '0');
  const reason = $('stockEntryReason').value.trim();

  const payload = { quantity, unit_cost, reason };

  if (isNewMode) {
    const newName = $('stockEntryNewName').value.trim();
    const newDosage = $('stockEntryNewDosage').value;
    const newPrice = parseFloat($('stockEntryNewPrice').value || '0');
    const newMinStock = parseInt($('stockEntryNewMinStock').value || '10', 10);

    if (!newName) {
      notice('Informe o nome da nova bebida.', 'error');
      $('stockEntryNewName').focus();
      return;
    }
    if (!newPrice || newPrice <= 0) {
      notice('Informe um preço de venda válido para a nova bebida.', 'error');
      $('stockEntryNewPrice').focus();
      return;
    }

    payload.new_drink_name = newName;
    payload.new_drink_dosage = newDosage;
    payload.new_drink_price = newPrice;
    payload.new_drink_min_stock = newMinStock;
  } else {
    const drink_id = parseInt($('stockEntryDrink').value, 10);
    if (!drink_id) {
      notice('Selecione uma bebida cadastrada ou marque "Cadastrar Nova Bebida".', 'error');
      return;
    }
    payload.drink_id = drink_id;
  }

  const submitBtn = $('stockEntrySubmitBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Processando...'; }

  try {
    const res = await api('stock/entry', {
      method: 'POST',
      body: payload
    });
    if (res.created_new_drink) {
      notice(`✓ Nova bebida "${res.drink_name}" cadastrada com entrada de ${quantity} un.!`, 'success');
    } else {
      notice(`✓ Entrada de ${quantity} un. de "${res.drink_name}" confirmada!`, 'success');
    }
    $('stockEntryForm').reset();
    setStockEntryMode('existing');
    $('stockEntryModal').style.display = 'none';
    await Promise.allSettled([refreshStock(), refreshBarMenu()]);
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Confirmar Entrada'; }
  }
});

$('stockAdjustForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const drink_id = parseInt($('stockAdjustDrink').value, 10);
  const new_quantity = parseInt($('stockAdjustQty').value, 10);
  const reason = $('stockAdjustReason').value.trim();

  try {
    await api('stock/adjust', {
      method: 'POST',
      body: { drink_id, new_quantity, reason }
    });
    notice('Ajuste de inventário salvo com sucesso!', 'success');
    $('stockAdjustForm').reset();
    $('stockAdjustModal').style.display = 'none';
    await refreshStock();
    await refreshBarMenu();
  } catch (err) {
    notice(err.message, 'error');
  }
});

$('stockSubTabOverview')?.addEventListener('click', () => {
  $('stockOverviewView').hidden = false;
  $('stockMovementsView').hidden = true;
  $('stockSubTabOverview').classList.add('primary');
  $('stockSubTabMovements').classList.remove('primary');
});

$('stockSubTabMovements')?.addEventListener('click', () => {
  $('stockOverviewView').hidden = true;
  $('stockMovementsView').hidden = false;
  $('stockSubTabMovements').classList.add('primary');
  $('stockSubTabOverview').classList.remove('primary');
  refreshStockMovements();
});

$('openStockEntryBtn')?.addEventListener('click', () => openStockEntryModal());
$('closeStockEntryBtn')?.addEventListener('click', () => { $('stockEntryModal').style.display = 'none'; });
$('openStockAdjustBtn')?.addEventListener('click', () => openStockAdjustModal());
$('closeStockAdjustBtn')?.addEventListener('click', () => { $('stockAdjustModal').style.display = 'none'; });
$('exportStockCsvBtn')?.addEventListener('click', exportStockCsv);
$('printStockBtn')?.addEventListener('click', () => window.print());
$('refreshStockBtn')?.addEventListener('click', () => refreshStock());
$('stockFilterApplyBtn')?.addEventListener('click', () => { stockMovementsPage = 1; refreshStockMovements(); });
$('stockMovementsPrev')?.addEventListener('click', () => { stockMovementsPage--; refreshStockMovements(); });
$('stockMovementsNext')?.addEventListener('click', () => { stockMovementsPage++; refreshStockMovements(); });

$('goToBarFromMenuBtn')?.addEventListener('click', () => switchTab('bar'));
$('goToStockFromMenuBtn')?.addEventListener('click', () => switchTab('stock'));
$('refreshMenuBtn')?.addEventListener('click', () => refreshBarMenu());
$('menuSearchInput')?.addEventListener('input', () => renderDrinksTable());

$('clientConsumptionSearchBtn')?.addEventListener('click', () => {
  consumptionPage = 1;
  refreshClientConsumption();
});
$('clientConsumptionQuery')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    consumptionPage = 1;
    refreshClientConsumption();
  }
});
$('clientConsumptionRefreshBtn')?.addEventListener('click', () => refreshClientConsumption());
$('consumptionPrev')?.addEventListener('click', () => {
  consumptionPage--;
  refreshClientConsumption();
});
$('consumptionNext')?.addEventListener('click', () => {
  consumptionPage++;
  refreshClientConsumption();
});
$('closeCdmBtn')?.addEventListener('click', () => {
  $('clientDetailsModal').style.display = 'none';
});

$('barDailyRefreshBtn')?.addEventListener('click', () => refreshDailyBarReport());
$('barDailyDate')?.addEventListener('change', () => refreshDailyBarReport());

api('session').then(showLoggedIn).catch(() => showLoggedOut());


