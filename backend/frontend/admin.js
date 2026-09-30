const $ = (id) => document.getElementById(id);
const apiRoot = new URL('../api/', window.location.href);
let session = null;
let origins = [];
let cardsPage = 1;
let originsPage = 1;
let partnersPage = 1;
let selectedPartner = null;
let cameraStream = null;
let scanActive = false;
let scanBusy = false;
let lastFrame = 0;
let detectorSupported = 'BarcodeDetector' in window;

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
  document.querySelectorAll('.admin-only').forEach((element) => {
    element.hidden = data.role !== 'admin';
  });
  $('issueOperatorNote').hidden = data.role === 'admin';
  await Promise.all([refreshOrigins(), refreshCards()]);
}

function switchTab(name) {
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  for (const section of document.querySelectorAll('.tab-panel')) {
    section.hidden = section.id !== `${name}Tab`;
  }
  if (name !== 'scan') stopCamera();
  if (name === 'partners') refreshPartners().catch((error) => notice(error.message, 'error'));
  notice('');
}

function renderPager(prefix, result) {
  const pageCount = Math.max(1, result.pages);
  $(`${prefix}Page`).textContent = `${result.total} registro(s) · página ${result.page} de ${pageCount}`;
  $(`${prefix}Prev`).disabled = result.page <= 1;
  $(`${prefix}Next`).disabled = result.page >= pageCount;
}

async function refreshOrigins() {
  const [result, options] = await Promise.all([
    api(`origins?page=${originsPage}&page_size=20`), api('origins/options'),
  ]);
  origins = options;
  const select = $('issueOrigin');
  const selected = select.value;
  const placeholder = node('option', '', 'Selecione uma origem');
  placeholder.value = '';
  const registeredGroup = node('optgroup');
  registeredGroup.label = 'Origens cadastradas';
  const prospectGroup = node('optgroup');
  prospectGroup.label = 'Lista comercial — a confirmar';
  const list = $('originList');
  list.replaceChildren();
  for (const origin of origins) {
    const label = origin.source === 'prospect'
      ? `${origin.name} — ${partnerStatusLabels[origin.status] || 'A confirmar'}`
      : origin.name;
    const option = node('option', '', label);
    option.value = origin.id;
    (origin.source === 'prospect' ? prospectGroup : registeredGroup).append(option);
  }
  select.replaceChildren(placeholder);
  if (registeredGroup.children.length) select.append(registeredGroup);
  if (prospectGroup.children.length) select.append(prospectGroup);
  select.value = origins.some((origin) => origin.id === selected) ? selected : '';
  $('originHelp').textContent = prospectGroup.children.length
    ? `${prospectGroup.children.length} locais da lista comercial disponíveis. Confirme a distribuição com o local antes de emitir; a origem será cadastrada na primeira emissão.`
    : 'Cadastre uma origem na aba Origens antes de emitir cartões.';
  for (const origin of result.items) {
    const card = node('div', 'origin-card');
    card.append(node('strong', '', origin.name), node('small', '', origin.category));
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
  const body = $('cardsBody');
  body.replaceChildren();
  for (const card of cards) {
    const row = node('tr');
    const [label, css] = statusLabel(card);
    const status = node('span', `badge ${css}`, label);
    const statusCell = node('td');
    statusCell.append(status);
    const action = node('button', '', 'Ver QR');
    action.type = 'button';
    action.addEventListener('click', () => {
      renderIssued([card]);
      switchTab('issue');
    });
    const actionCell = node('td');
    actionCell.append(action);
    row.append(node('td', '', card.number), node('td', '', card.origin_name), statusCell,
      node('td', '', formatDate(card.issued_at)), actionCell);
    body.append(row);
  }
  if (!cards.length) {
    const row = node('tr');
    const cell = node('td', '', 'Nenhum cartão emitido ainda.');
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
  renderPager('cards', result);
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
  const target = $('issuedCards');
  target.replaceChildren();
  for (const card of cards) {
    const item = node('article', 'print-card');
    const image = node('img');
    image.alt = `QR do cartão ${card.number}`;
    image.src = card.qr_data_url || new URL(`cards/${encodeURIComponent(card.token)}/qr.svg`, apiRoot).toString();
    item.append(node('strong', '', 'VIBZ TOURIST PASS'), image,
      node('strong', '', card.number), node('div', 'origin', card.origin_name),
      node('small', '', card.valid_until ? `Válido até ${card.valid_until}` : 'Entrada cortesia · consumo não incluso'));
    target.append(item);
  }
  $('issuedActions').hidden = cards.length === 0;
  $('issuedCount').textContent = `${cards.length} cartão(ões) pronto(s) para imprimir`;
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
    fields.push(['Entrada', formatDate(card.redeemed_at)], ['Pulseira', card.wristband || '—']);
  }
  for (const [title, value] of fields) {
    const cell = node('div');
    cell.append(node('dt', '', title), node('dd', '', value));
    details.append(cell);
  }
  panel.append(badge, node('h3', '', card.number), details);
  if (card.status === 'issued' && !card.expired) {
    const form = node('form', 'redeem-form');
    const label = node('label', '', 'Número da pulseira');
    const input = node('input');
    input.required = true;
    input.maxLength = 32;
    input.placeholder = 'Ex.: 0387';
    label.append(input);
    const button = node('button', 'primary', 'Liberar entrada');
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
        notice(`${updated.number} liberado. Pulseira ${updated.wristband} vinculada.`, 'success');
        await refreshCards();
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

async function lookupQr(value) {
  const card = await api('lookup', {method: 'POST', body: {qr: value}});
  renderCard(card);
  stopCamera();
  notice(`${card.number} identificado: ${card.origin_name}.`, card.status === 'issued' && !card.expired ? 'success' : 'error');
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
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('A câmera exige HTTPS e permissão do navegador.');
  if (!detectorSupported && !window.jsQR) throw new Error('Leitor de QR indisponível neste navegador. Use o campo de código.');
  stopCamera();
  cameraStream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}}, audio: false});
  $('camera').srcObject = cameraStream;
  $('camera').hidden = false;
  $('cameraPlaceholder').hidden = true;
  await $('camera').play();
  scanActive = true;
  requestAnimationFrame(scanFrame);
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
    await api('origins', {method: 'POST', body: {name: $('originName').value.trim(), category: $('originCategory').value}});
    event.target.reset();
    originsPage = 1;
    await refreshOrigins();
    notice('Origem cadastrada.', 'success');
  } catch (error) { notice(error.message, 'error'); }
});
$('cardsPrev').addEventListener('click', () => { cardsPage--; refreshCards().catch((error) => notice(error.message, 'error')); });
$('cardsNext').addEventListener('click', () => { cardsPage++; refreshCards().catch((error) => notice(error.message, 'error')); });
$('originsPrev').addEventListener('click', () => { originsPage--; refreshOrigins().catch((error) => notice(error.message, 'error')); });
$('originsNext').addEventListener('click', () => { originsPage++; refreshOrigins().catch((error) => notice(error.message, 'error')); });
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
    const data = Object.fromEntries(new FormData(event.target).entries());
    data.estimated_rooms = data.estimated_rooms === '' ? null : Number(data.estimated_rooms);
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') data[key] = value.trim();
    }
    if (data.status === 'parceiro' && selectedPartner.status !== 'parceiro' &&
        !window.confirm('A parceria foi confirmada com este estabelecimento?')) return;
    const changes = Object.fromEntries(Object.entries(data).filter(([key, value]) => value !== selectedPartner[key]));
    if (!Object.keys(changes).length) {
      notice('Nenhuma alteração para salvar.');
      return;
    }
    await api(`partners/${encodeURIComponent(selectedPartner.id)}`, {method: 'PATCH', body: changes});
    event.target.hidden = true;
    selectedPartner = null;
    await refreshPartners();
    notice('Estabelecimento atualizado.', 'success');
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('issueForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const chosen = origins.find((origin) => origin.id === $('issueOrigin').value);
    if (chosen?.source === 'prospect' && chosen.status !== 'parceiro' &&
        !window.confirm(`${chosen.name} ainda não está marcado como parceiro. A distribuição foi combinada com esse local?`)) return;
    const cards = await api('cards', {method: 'POST', body: {
      origin_id: $('issueOrigin').value,
      count: Number($('issueCount').value),
      valid_until: $('issueExpiry').value || null,
    }});
    renderIssued(cards);
    cardsPage = 1;
    await refreshCards();
    notice(`Lote emitido: ${cards[0].number} a ${cards[cards.length - 1].number}.`, 'success');
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('printCards').addEventListener('click', () => window.print());
$('refreshCards').addEventListener('click', () => refreshCards().catch((error) => notice(error.message, 'error')));
$('lookupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await lookupQr($('qrInput').value); } catch (error) { notice(error.message, 'error'); }
});
$('startCamera').addEventListener('click', () => startCamera().catch((error) => notice(error.message, 'error')));
$('stopCamera').addEventListener('click', stopCamera);
window.addEventListener('pagehide', stopCamera);

api('session').then(showLoggedIn).catch(() => showLoggedOut());
