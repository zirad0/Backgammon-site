const STORAGE_KEY = 'tavla_ui_prefs_v2';
const PLAYER_TOKEN_KEY = 'tavla_player_token_v3';
let storedPrefs = {};
try { storedPrefs = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
catch { localStorage.removeItem(STORAGE_KEY); }

// Her sekmenin ayrı oyuncu kimliği vardır; sayfa yenilenince kimlik korunur.
const playerToken = sessionStorage.getItem(PLAYER_TOKEN_KEY) || (() => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(PLAYER_TOKEN_KEY, token);
  return token;
})();

const socket = io();

const state = {
  me: { roomCode: null, color: null, name: storedPrefs.lastName || null, playerToken },
  room: null,
  selectedFrom: null,
  possibleTargets: [],
  blockedTargets: [],
  actionMap: {},
  audioCtx: null,
  lastRoundMessage: '',
  animating: false,
  floatingChecker: null,
  diceAnimating: false,
  diceAnimationTimer: null,
  diceAnimationValues: [],
  lastRoundSummaryId: null,
  lastMatchSummaryId: null,
  chatMessages: [],
  publicRooms: [],
  theme: storedPrefs.theme || 'classic',
  skin: storedPrefs.skin || 'classic',
  autoDice: storedPrefs.autoDice !== false,
  toastTimer: null,
  suppressReconnect: false,
  leaveRequested: false
};

const UI = window.UI_TEXT || {};
const SOUND_FILES = {
  roll: 'assets/sounds/roll.wav',
  move: 'assets/sounds/move.wav',
  hit: 'assets/sounds/hit.wav'
};
const THEME_OPTIONS = window.TAVLA_THEMES || [];
const SKIN_OPTIONS = window.TAVLA_SKINS || [];
function currentSkinAsset(color) {
  const selected = SKIN_OPTIONS.find((skin) => skin.id === state.skin) || SKIN_OPTIONS[0];
  if (!selected) return `assets/checkers/${color}.svg`;
  return selected[color] || `assets/checkers/${color}.svg`;
}
function t(key, vars = {}) {
  let value = UI[key] ?? key;
  for (const [k, v] of Object.entries(vars)) value = value.replaceAll(`{${k}}`, v);
  return value;
}
function applyUIText() {
  document.querySelectorAll('[data-text]').forEach((el) => {
    el.textContent = t(el.dataset.text);
  });
}

function savePrefs() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    theme: state.theme,
    skin: state.skin,
    autoDice: state.autoDice,
    lastName: state.me.name || createName.value.trim() || joinName.value.trim() || ''
  }));
}

function applyTheme(themeId = state.theme) {
  const exists = THEME_OPTIONS.some((theme) => theme.id === themeId);
  state.theme = exists ? themeId : (THEME_OPTIONS[0]?.id || 'classic');
  document.body.dataset.theme = state.theme;
  document.querySelectorAll('[data-theme-option]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeOption === state.theme);
  });
  savePrefs();
}

function applySkin(skinId = state.skin) {
  const exists = SKIN_OPTIONS.some((skin) => skin.id === skinId);
  state.skin = exists ? skinId : (SKIN_OPTIONS[0]?.id || 'classic');
  document.querySelectorAll('[data-skin-option]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.skinOption === state.skin);
  });
  savePrefs();
  renderBoard();
}

function renderThemeOptions() {
  if (!themeOptionsEl) return;
  themeOptionsEl.innerHTML = '';
  for (const theme of THEME_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = 'optionButton';
    btn.dataset.themeOption = theme.id;
    btn.innerHTML = `${theme.label} <span class="miniPreview"><span style="background:${theme.id === 'dark' ? '#121722' : theme.id === 'forest' ? '#4a7b4f' : '#d39a63'}"></span><span style="background:${theme.id === 'dark' ? '#7d95ff' : theme.id === 'forest' ? '#2c8f58' : '#367cff'}"></span></span>`;
    btn.addEventListener('click', () => applyTheme(theme.id));
    themeOptionsEl.appendChild(btn);
  }
}

function renderSkinOptions() {
  if (!skinOptionsEl) return;
  skinOptionsEl.innerHTML = '';
  for (const skin of SKIN_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = 'optionButton';
    btn.dataset.skinOption = skin.id;
    btn.innerHTML = `${skin.label} <span class="miniPreview"><span style="background-image:url(${skin.white}); background-size:cover; background-position:center;"></span><span style="background-image:url(${skin.black}); background-size:cover; background-position:center;"></span></span>`;
    btn.addEventListener('click', () => applySkin(skin.id));
    skinOptionsEl.appendChild(btn);
  }
}

function getRoomShareUrl(roomCode = state.me.roomCode) {
  if (!roomCode) return '';
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomCode);
  return url.toString();
}

function updateRoomLinkPreview() {
  if (roomLinkPreview) roomLinkPreview.textContent = state.me.roomCode ? getRoomShareUrl(state.me.roomCode) : '';
}

function prefillLobbyFromPrefs() {
  createName.value = '';
  joinName.value = '';
  const url = new URL(window.location.href);
  const roomCode = (url.searchParams.get('room') || '').trim().toUpperCase();
  if (roomCode) roomCodeInput.value = roomCode.slice(0, 5);
}

const $ = (id) => document.getElementById(id);
const lobbyScreen = $('lobbyScreen');
const gameScreen = $('gameScreen');
const createRoomBtn = $('createRoomBtn');
const joinRoomBtn = $('joinRoomBtn');
const createName = $('createName');
const joinName = $('joinName');
const roomCodeInput = $('roomCodeInput');
const matchHistoryListEl = $('matchHistoryList');
const refreshHistoryBtn = $('refreshHistoryBtn');
const targetScoreSelect = $('targetScore');
const lobbyMessage = $('lobbyMessage');
const roomCodeLabel = $('roomCodeLabel');
const copyRoomBtn = $('copyRoomBtn');
const board = $('board');
const statusText = $('statusText');
const turnBadge = $('turnBadge');
const whiteName = $('whiteName');
const blackName = $('blackName');
const whiteScore = $('whiteScore');
const blackScore = $('blackScore');
const targetLabel = $('targetLabel');
const rollDiceBtn = $('rollDiceBtn');
const confirmBtn = $('confirmBtn');
const resetTurnBtn = $('resetTurnBtn');
const diceArea = $('diceArea');
const roundModal = $('roundModal');
const roundModalText = $('roundModalText');
const closeRoundModalBtn = $('closeRoundModalBtn');
const whiteCard = $('whiteCard');
const blackCard = $('blackCard');
const tableWrap = $('tableWrap');
const boardZoomBtn = $('boardZoomBtn');
const mobileBoardTip = $('mobileBoardTip');
const chatMessagesEl = $('chatMessages');
const chatInput = $('chatInput');
const sendChatBtn = $('sendChatBtn');
const matchModal = $('matchModal');
const matchModalText = $('matchModalText');
const rematchBtn = $('rematchBtn');
const roomLinkPreview = $('roomLinkPreview');
const themeOptionsEl = $('themeOptions');
const skinOptionsEl = $('skinOptions');
const autoDiceCheckbox = $('autoDiceCheckbox');
const autoDiceLabelText = $('autoDiceLabelText');
const doubleOfferBtn = $('doubleOfferBtn');
const doubleStatusText = $('doubleStatusText');
const doubleModal = $('doubleModal');
const doubleModalText = $('doubleModalText');
const acceptDoubleBtn = $('acceptDoubleBtn');
const declineDoubleBtn = $('declineDoubleBtn');
const toastLayer = $('toastLayer');
const leaveRoomBtn = $('leaveRoomBtn');
const matchExitBtn = $('matchExitBtn');
const doubleExitBtn = $('doubleExitBtn');
const rematchStatusText = $('rematchStatusText');
const connectionStatus = $('connectionStatus');
const publicRoomsListEl = $('publicRoomsList');
const publicRoomsCountEl = $('publicRoomsCount');
const refreshPublicRoomsBtn = $('refreshPublicRoomsBtn');
const gameVisibilityBadge = $('gameVisibilityBadge');


function showToast(message, variant = 'info') {
  if (!toastLayer || !message) return;
  const toast = document.createElement('div');
  toast.className = `toast ${variant}`;
  toast.textContent = message;
  toastLayer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  const remove = () => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 240);
  };
  setTimeout(remove, 2600);
}

// Mobil tahta CSS grid ile ekrana uyarlanır: transform ölçeklemesi dokunma
// hedeflerini ve görsel ölçüleri bozduğu için kullanılmaz.
function updateBoardScale() {
  if (!board || !tableWrap) return;
  board.classList.remove('mobileScaled');
  board.style.removeProperty('--board-scale');
  tableWrap.style.removeProperty('--board-height');
  const smallScreen = window.matchMedia('(max-width: 860px)').matches;
  if (!smallScreen) tableWrap.classList.remove('boardZoomed');
  if (boardZoomBtn) {
    const expanded = smallScreen && tableWrap.classList.contains('boardZoomed');
    boardZoomBtn.setAttribute('aria-pressed', String(expanded));
    boardZoomBtn.textContent = expanded ? '↔ Ekrana sığdır' : '⌕ Tahtayı büyüt';
  }
  if (mobileBoardTip) {
    mobileBoardTip.textContent = smallScreen && window.innerWidth < 300
      ? 'Dar ekran: Tahtayı yana kaydırarak tüm noktaları görebilirsin.'
      : 'Taşlar küçük görünüyorsa büyütebilir, tahtayı yana kaydırabilirsin.';
  }
}

boardZoomBtn?.addEventListener('click', () => {
  if (!tableWrap || !window.matchMedia('(max-width: 860px)').matches) return;
  tableWrap.classList.toggle('boardZoomed');
  tableWrap.scrollLeft = 0;
  updateBoardScale();
});
window.addEventListener('resize', updateBoardScale, { passive: true });
window.visualViewport?.addEventListener('resize', updateBoardScale, { passive: true });

function playSound(type = 'move') {

  const src = SOUND_FILES[type];
  if (!src) return;
  try {
    const audio = new Audio(src);
    audio.volume = type === 'hit' ? 0.6 : 0.45;
    audio.play().catch(() => {});
  } catch {}
}

function setLobbyMessage(text, error = true) {
  lobbyMessage.textContent = text;
  lobbyMessage.style.color = error ? '#cc4158' : '#2d8a52';
}

function updateAutoDiceControls() {
  if (autoDiceCheckbox) autoDiceCheckbox.checked = !!state.autoDice;
  if (autoDiceLabelText) autoDiceLabelText.textContent = state.autoDice ? 'Otomatik zar' : 'Manuel zar';
  if (rollDiceBtn) {
    rollDiceBtn.textContent = state.autoDice ? 'Sıran gelince otomatik atılacak' : 'Zar At';
    rollDiceBtn.classList.toggle('isAuto', !!state.autoDice);
  }
}

function setAutoDice(enabled, syncServer = true) {
  state.autoDice = !!enabled;
  updateAutoDiceControls();
  savePrefs();
  if (syncServer) socket.emit('settings:autoDice', { enabled: state.autoDice });
}

function clearSelection() {
  state.selectedFrom = null;
  state.possibleTargets = [];
  state.blockedTargets = [];
  state.actionMap = {};
}

function isWhite() {
  return state.me.color === 'white';
}

function topPlayerColor() {
  return state.me.color === 'black' ? 'white' : 'black';
}

function bottomPlayerColor() {
  return state.me.color || 'white';
}

function perspectiveTopIndices() {
  return state.me.color === 'black'
    ? [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
    : [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
}

function perspectiveBottomIndices() {
  return state.me.color === 'black'
    ? [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
    : [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
}

function ownCheckerAt(pointIndex) {
  const value = state.room?.game?.state?.points?.[pointIndex] || 0;
  return isWhite() ? value > 0 : value < 0;
}

function blockedByOpponent(pointIndex) {
  const value = state.room?.game?.state?.points?.[pointIndex] || 0;
  return isWhite() ? value <= -2 : value >= 2;
}

function destinationPoint(from, die) {
  if (from === 'bar') return isWhite() ? 24 - die : die - 1;
  return isWhite() ? from - die : from + die;
}

function getMyMoveOptions() {
  if (!state.room || state.animating) return [];
  if (state.room.game.turn !== state.me.color) return [];
  return state.room.game.moveOptions || [];
}

function countByValue(values) {
  const counts = new Map();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  return counts;
}

function showRoundSummary(summary) {
  if (!summary || state.lastRoundSummaryId === summary.id) return;
  state.lastRoundSummaryId = summary.id;
  roundModalText.textContent = summary.text;
  roundModal.classList.remove('hidden');
}

function showMatchSummary(summary) {
  if (!summary || state.lastMatchSummaryId === summary.id) return;
  state.lastMatchSummaryId = summary.id;
  matchModalText.textContent = summary.text;
  matchModal.classList.remove('hidden');
}


function closeDoubleModal() {
  doubleModal?.classList.add('hidden');
}

function showDoubleOffer(offer) {
  if (!offer || !state.room) return;
  const offerer = state.room.players?.[offer.offeredBy]?.name || 'Rakip';
  if (offer.offeredBy === state.me.color) return;
  doubleModalText.textContent = `${offerer} 2x teklifi gönderdi. Kabul edersen normal galibiyet 2, mars 4 puan kazandırır. Reddedersen ${offerer} 2 puan alır.`;
  doubleModal?.classList.remove('hidden');
}

function formatChatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderChat() {
  if (!chatMessagesEl) return;
  chatMessagesEl.innerHTML = '';
  const messages = state.chatMessages || [];
  if (!messages.length) {
    chatMessagesEl.innerHTML = '<div class="muted">Henüz mesaj yok.</div>';
    return;
  }
  for (const msg of messages.slice(-80)) {
    const row = document.createElement('div');
    row.className = `chatMessage ${msg.color === state.me.color ? 'mine' : ''} ${msg.color === 'system' ? 'system' : ''}`;
    row.innerHTML = `
      <div class="chatMeta">
        <span class="chatName">${escapeHtml(msg.name || 'Sistem')}</span>
        <span class="chatTime">${formatChatTime(msg.timestamp)}</span>
      </div>
      <div class="chatBubble">${escapeHtml(msg.text || '')}</div>
    `;
    chatMessagesEl.appendChild(row);
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function sendChat() {
  const text = (chatInput?.value || '').trim();
  if (!text) return;
  socket.emit('chat:send', { text });
  chatInput.value = '';
}

function renderPublicRooms() {
  if (!publicRoomsListEl || !publicRoomsCountEl) return;
  const publicRooms = state.publicRooms || [];
  publicRoomsCountEl.textContent = String(publicRooms.length);
  publicRoomsListEl.replaceChildren();
  if (!publicRooms.length) {
    const empty = document.createElement('div');
    empty.className = 'emptyPublicRooms';
    empty.textContent = socket.connected
      ? 'Şu anda bekleyen herkese açık oda yok. İlk odayı sen açabilirsin!'
      : 'Sunucu bağlantısı bekleniyor...';
    publicRoomsListEl.appendChild(empty);
    return;
  }
  for (const room of publicRooms) {
    const card = document.createElement('article');
    card.className = 'publicRoomCard';
    const roomDetails = document.createElement('div');
    roomDetails.className = 'publicRoomDetails';
    const heading = document.createElement('strong');
    heading.className = 'publicRoomCode';
    heading.textContent = `🎲 ${room.roomCode}`;
    const players = document.createElement('div');
    players.className = 'publicRoomPlayers';
    const names = Array.isArray(room.players) ? room.players.map(p => p.name).join(', ') : '';
    players.textContent = `Oyuncular: ${names || 'Bekleniyor'}`;
    const meta = document.createElement('div');
    meta.className = 'publicRoomMeta';
    meta.textContent = `${room.playerCount || 1}/2 oyuncu · ${room.targetScore} puanlık maç · Rakip bekliyor`;
    roomDetails.append(heading, players, meta);
    const joinButton = document.createElement('button');
    joinButton.type = 'button';
    joinButton.className = 'publicRoomJoinBtn';
    joinButton.textContent = 'Katıl';
    joinButton.disabled = !socket.connected;
    joinButton.setAttribute('aria-label', `${room.roomCode} kodlu odaya katıl`);
    joinButton.addEventListener('click', () => joinRoom(room.roomCode));
    card.append(roomDetails, joinButton);
    publicRoomsListEl.appendChild(card);
  }
}

function requestMyHistory() {
  if (!socket.connected) return;
  socket.emit('history:request', { playerToken: state.me.playerToken });
}
function renderMatchHistory(items = []) {
  if (!matchHistoryListEl) return;
  matchHistoryListEl.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'emptyPublicRooms';
    empty.textContent = 'Bu oyuncu anahtarına bağlı tamamlanmış veya yarıda kalmış maç bulunamadı.';
    matchHistoryListEl.appendChild(empty);
    return;
  }
  for (const match of items) {
    const card = document.createElement('article');
    card.className = 'matchHistoryItem';
    const title = document.createElement('strong');
    title.textContent = `${match.players?.white || 'Beyaz'} – ${match.players?.black || 'Siyah'}`;
    const score = document.createElement('span');
    score.textContent = `${match.scores?.white ?? 0} : ${match.scores?.black ?? 0} · Hedef ${match.targetScore}`;
    const result = document.createElement('span');
    result.className = `historyResult ${match.status === 'interrupted' ? 'interrupted' : ''}`;
    result.textContent = match.status === 'interrupted' ? 'Maç yarıda kaldı' :
      `Kazanan: ${match.players?.[match.winner] || 'Bilinmiyor'}`;
    const date = document.createElement('small');
    date.textContent = Number.isFinite(match.finishedAt)
      ? new Date(match.finishedAt).toLocaleString('tr-TR') : '';
    card.append(title, score, result, date);
    matchHistoryListEl.appendChild(card);
  }
}

function createRoom() {
  const name = createName.value.trim() || 'Oyuncu 1';
  state.me.name = name;
  savePrefs();
  if (!socket.connected) return setLobbyMessage('Sunucuya bağlantı kurulamadı. Biraz sonra tekrar dene.');
  setLobbyMessage('', false);
  const visibility = document.querySelector('input[name="roomVisibility"]:checked')?.value || 'private';
  socket.emit('room:create', { name, targetScore: targetScoreSelect.value, visibility, playerToken: state.me.playerToken, autoDice: state.autoDice });
}

function joinRoom(requestedCode = null) {
  const name = joinName.value.trim() || createName.value.trim() || 'Oyuncu 2';
  const roomCode = (typeof requestedCode === 'string' ? requestedCode : roomCodeInput.value).trim().toUpperCase();
  state.me.name = name;
  if (roomCode) roomCodeInput.value = roomCode;
  if (!roomCode) {
    setLobbyMessage(t('needRoomCode'));
    return;
  }
  if (!socket.connected) return setLobbyMessage('Sunucuya bağlantı kurulamadı. Biraz sonra tekrar dene.');
  savePrefs();
  setLobbyMessage('', false);
  socket.emit('room:join', { roomCode, name, playerToken: state.me.playerToken, autoDice: state.autoDice });
}

createRoomBtn.addEventListener('click', createRoom);
joinRoomBtn.addEventListener('click', () => joinRoom());
refreshHistoryBtn?.addEventListener('click', requestMyHistory);
refreshPublicRoomsBtn?.addEventListener('click', () => {
  if (socket.connected) { socket.emit('rooms:request'); requestMyHistory(); }
});
roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});
copyRoomBtn.addEventListener('click', async () => {
  if (!state.me.roomCode) return;
  try {
    await navigator.clipboard.writeText(getRoomShareUrl());
    copyRoomBtn.textContent = t('copied');
    setTimeout(() => (copyRoomBtn.textContent = t('copy')), 1000);
  } catch { showToast('Bağlantı kopyalanamadı. Yukarıdaki bağlantıyı kendin kopyalayabilirsin.', 'warning'); }
});
rollDiceBtn.addEventListener('click', () => {
  if (state.autoDice) return;
  socket.emit('dice:roll');
});
autoDiceCheckbox?.addEventListener('change', (event) => {
  setAutoDice(!!event.target.checked);
});
confirmBtn.addEventListener('click', () => socket.emit('turn:confirm'));
resetTurnBtn.addEventListener('click', () => socket.emit('turn:reset'));
doubleOfferBtn?.addEventListener('click', () => {
  if (!state.room || !state.me.color) return;
  socket.emit('double:offer');
});
acceptDoubleBtn?.addEventListener('click', () => {
  socket.emit('double:respond', { accept: true });
  closeDoubleModal();
});
declineDoubleBtn?.addEventListener('click', () => {
  socket.emit('double:respond', { accept: false });
  closeDoubleModal();
});
closeRoundModalBtn.addEventListener('click', () => roundModal.classList.add('hidden'));
sendChatBtn?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendChat();
});
rematchBtn?.addEventListener('click', () => {
  if (!state.room?.game?.winner) return;
  rematchBtn.disabled = true;
  socket.emit('match:rematch');
});

function showLobby(message = '', error = false) {
  stopDiceAnimation();
  clearSelection();
  if (state.floatingChecker) state.floatingChecker.remove();
  state.floatingChecker = null;
  state.room = null;
  state.animating = false;
  state.chatMessages = [];
  state.me.roomCode = null;
  state.me.color = null;
  state.lastMatchSummaryId = null;
  state.lastRoundSummaryId = null;
  gameScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  roundModal.classList.add('hidden');
  matchModal.classList.add('hidden');
  closeDoubleModal();
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState(null, '', url.toString());
  setLobbyMessage(message, error);
  if (socket.connected) { socket.emit('rooms:request'); requestMyHistory(); }
}

function leaveRoom() {
  if (!state.me.roomCode || state.leaveRequested) return;
  if (!socket.connected) return showToast('Odadan ayrılmak için önce sunucuya yeniden bağlanmalısın.', 'warning');
  if (!window.confirm('Odadan çıkarsan oyun ve oda iki oyuncu için de kapanacak. Çıkmak istiyor musun?')) return;
  state.leaveRequested = true;
  state.suppressReconnect = true;
  socket.emit('room:leave', { playerToken: state.me.playerToken });
  showLobby('Odadan ayrıldın. Yeni bir oda açabilir veya başka bir odaya katılabilirsin.', false);
  state.leaveRequested = false;
}
leaveRoomBtn?.addEventListener('click', leaveRoom);
matchExitBtn?.addEventListener('click', leaveRoom);
doubleExitBtn?.addEventListener('click', leaveRoom);

function renderConnectionStatus() {
  if (!connectionStatus) return;
  const connected = socket.connected;
  connectionStatus.classList.toggle('offline', !connected);
  connectionStatus.innerHTML = `<span class="connectionDot"></span> ${connected ? 'Sunucuya bağlı' : 'Bağlantı bekleniyor'}`;
  createRoomBtn.disabled = !connected;
  joinRoomBtn.disabled = !connected;
  if (refreshPublicRoomsBtn) refreshPublicRoomsBtn.disabled = !connected;
  if (refreshHistoryBtn) refreshHistoryBtn.disabled = !connected;
  renderPublicRooms();
}

applyUIText();
renderThemeOptions();
renderSkinOptions();
applyTheme(state.theme);
applySkin(state.skin);
updateAutoDiceControls();
prefillLobbyFromPrefs();

socket.on('connect', () => {
  // Sunucu yeniden bağlandığında oyuncunun odasını geri iste.
  renderConnectionStatus();
  socket.emit('rooms:request');
  requestMyHistory();
  if (state.me.playerToken && !state.suppressReconnect) {
    socket.emit('player:reconnect', { playerToken: state.me.playerToken, autoDice: state.autoDice });
  }
});
socket.on('disconnect', () => {
  renderConnectionStatus();
  state.publicRooms = [];
  renderPublicRooms();
  if (state.me.roomCode) statusText.textContent = 'Bağlantı kesildi. Yeniden bağlanılıyor...';
  rollDiceBtn.disabled = true;
  confirmBtn.disabled = true;
  resetTurnBtn.disabled = true;
  if (doubleOfferBtn) doubleOfferBtn.disabled = true;
});

// Rakibin geri dönüş süresi ekran açıkken de güncellensin.
setInterval(() => {
  if (!socket.connected || !state.room?.players || !state.me.color) return;
  const rival = state.room.players[state.me.color === 'white' ? 'black' : 'white'];
  if (!rival || rival.connected || !rival.reconnectUntil) return;
  const remaining = Math.max(0, Math.ceil((rival.reconnectUntil - Date.now()) / 60000));
  statusText.textContent = `Rakip koptu; maç durdu. Yeniden bağlanmak için ${remaining} dakika kaldı.`;
}, 15000);

socket.on('history:list', (items) => renderMatchHistory(Array.isArray(items) ? items : []));
socket.on('rooms:list', (rooms) => {
  state.publicRooms = Array.isArray(rooms) ? rooms : [];
  renderPublicRooms();
});

socket.on('player:reconnect-missing', () => {
  if (state.me.roomCode && !state.leaveRequested) {
    showLobby('Oda bulunamadı veya bağlantı kurtarma süresi doldu. Yeni oda açabilirsin.', true);
  }
});
socket.on('room:closed', ({ reason } = {}) => {
  state.suppressReconnect = false;
  if (state.me.roomCode) showLobby(reason || 'Oda kapatıldı.', false);
});
socket.on('room:session-taken', () => {
  state.suppressReconnect = true;
  showLobby('Bu oyuncu oturumu başka bir sekmede açıldı. Buradan devam etmek için diğer sekmeyi kapatıp sayfayı yenile.', true);
});
socket.on('game:error', (message) => showToast(message, 'warning'));

socket.on('dice:rolling', ({ duration = 900 }) => {
  startDiceAnimation(duration);
});

socket.on('room:joined', ({ roomCode, color }) => {
  if (state.me.roomCode !== roomCode) {
    state.lastMatchSummaryId = null;
    state.lastRoundSummaryId = null;
  }
  state.suppressReconnect = false;
  state.me.roomCode = roomCode;
  state.me.color = color;
  state.leaveRequested = false;
  updateRoomLinkPreview();
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  roomCodeLabel.textContent = roomCode;
  setLobbyMessage('', false);
  matchModal.classList.add('hidden');
  socket.emit('settings:autoDice', { enabled: state.autoDice });
});

socket.on('room:error', (message) => setLobbyMessage(message, true));

socket.on('chat:message', (message) => {
  state.chatMessages = [...(state.chatMessages || []), message];
  renderChat();
});

socket.on('move:animate', async ({ color, path }) => {
  if (!path?.length) return;
  state.animating = true;
  clearSelection();
  renderBoard();
  await animateMove(color, path);
});

socket.on('state:update', (roomState) => {
  const previousDice = JSON.stringify(state.room?.game?.rolledPair || []);
  const nextDice = JSON.stringify(roomState.game.rolledPair || []);
  const prevPoints = JSON.stringify(state.room?.game?.state?.points || []);
  const nextPoints = JSON.stringify(roomState.game.state.points || []);
  const prevBars = JSON.stringify(state.room?.game?.state?.bar || {});
  const nextBars = JSON.stringify(roomState.game.state.bar || {});
  const previousDoubleOffer = state.room?.game?.doubleOffer || null;
  const previousMultiplier = state.room?.game?.roundMultiplier || 1;

  if (!state.me.roomCode || roomState.roomCode !== state.me.roomCode) return;
  state.room = roomState;
  if (gameVisibilityBadge) gameVisibilityBadge.textContent = roomState.visibility === 'public' ? 'Herkese açık' : 'Özel oda';
  updateRoomLinkPreview();
  savePrefs();
  state.animating = !!roomState.game.animating;

  if (roomState.game.rolledPair || roomState.game.doubleOffer || roomState.game.winner) stopDiceAnimation();

  if (previousDice !== nextDice && roomState.game.rolledPair) playSound('roll');
  if (prevPoints !== nextPoints) playSound('move');
  if (prevBars !== nextBars) playSound('hit');

  whiteName.textContent = roomState.players.white?.name || t('player1');
  blackName.textContent = roomState.players.black?.name || t('player2');
  whiteScore.textContent = roomState.game.scores.white;
  blackScore.textContent = roomState.game.scores.black;
  targetLabel.textContent = roomState.game.targetScore;
  const targetLabelSuffix = $('targetLabelSuffix');
  if (targetLabelSuffix) targetLabelSuffix.textContent = t('scoresTarget', { score: roomState.game.targetScore }).replace(String(roomState.game.targetScore) + ' ', '');

  const myTurn = roomState.game.turn === state.me.color;
  const bothPlayersReady = !!roomState.players.white && !!roomState.players.black;
  const enemyConnected = state.me.color === 'white'
    ? roomState.players.black?.connected
    : roomState.players.white?.connected;

  whiteCard.classList.remove('active-turn');
  blackCard.classList.remove('active-turn');
  tableWrap?.classList.toggle('active-turn-board', myTurn && !roomState.game.winner && bothPlayersReady);
  state.chatMessages = roomState.chat || state.chatMessages || [];

  turnBadge.textContent = roomState.game.winner
    ? t('wonMatch', { name: roomState.game.winner === 'white' ? (roomState.players.white?.name || t('white')) : (roomState.players.black?.name || t('black')) })
    : myTurn ? t('yourTurn') : t('enemyTurn');

  if (!bothPlayersReady) {
    statusText.textContent = t('waitingRoom');
  } else if (enemyConnected === false) {
    const deadline = roomState.players[state.me.color === 'white' ? 'black' : 'white']?.reconnectUntil;
    statusText.textContent = deadline ? `Rakip koptu; maç durdu. Yeniden bağlanmak için ${Math.max(0, Math.ceil((deadline - Date.now()) / 60000))} dakika kaldı.` : t('enemyDisconnected');
  } else if (roomState.game.winner) {
    statusText.textContent = t('matchWon');
  } else if (roomState.game.animating) {
    statusText.textContent = t('animating');
  } else if (state.diceAnimating || roomState.game.diceRolling) {
    statusText.textContent = t('rollingDice');
  } else if (roomState.game.waitingForRoll) {
    const autoTurn = roomState.game.turn === state.me.color ? state.autoDice : !!roomState.players?.[roomState.game.turn]?.autoDice;
    statusText.textContent = myTurn
      ? (state.autoDice ? t('autoRollingSoon') : t('yourTurnRoll'))
      : (autoTurn ? t('enemyAutoRollingSoon') : t('enemyTurnRoll'));
  } else if (roomState.game.noMovesAvailable) {
    statusText.textContent = myTurn ? t('noMovesYou') : t('noMovesEnemy');
  } else if (roomState.game.state.bar[state.me.color] > 0 && myTurn) {
    statusText.textContent = t('barFirst');
  } else if (roomState.game.movedThisTurn && roomState.game.moveOptions.length > 0 && myTurn) {
    statusText.textContent = t('useRemaining');
  } else {
    statusText.textContent = myTurn ? t('selectHint') : t('enemyWaiting');
  }

  updateAutoDiceControls();
  rollDiceBtn.disabled = !socket.connected || !enemyConnected || state.autoDice || !myTurn || !roomState.game.waitingForRoll || roomState.game.winner || roomState.game.animating || state.diceAnimating || !!roomState.game.doubleOffer;
  confirmBtn.disabled = !socket.connected || !enemyConnected || !myTurn || !roomState.game.canConfirm || roomState.game.winner || roomState.game.animating || !!roomState.game.doubleOffer;
  resetTurnBtn.disabled = !socket.connected || !enemyConnected || !myTurn || !roomState.game.hasRolled || !roomState.game.movedThisTurn || roomState.game.winner || roomState.game.animating || !!roomState.game.doubleOffer;

  if (doubleStatusText) {
    if (roomState.game.doubleOffer) {
      const offererName = roomState.players?.[roomState.game.doubleOffer.offeredBy]?.name || 'Rakip';
      doubleStatusText.textContent = roomState.game.doubleOffer.offeredBy === state.me.color
        ? 'Teklif gönderildi, rakip cevap bekleniyor'
        : `${offererName} senden 2x cevabı bekliyor`;
    } else if (roomState.game.roundMultiplier > 1) {
      doubleStatusText.textContent = `Bu el ${roomState.game.roundMultiplier}x puan veriyor`;
    } else if (!roomState.game.noContactPhase) {
      doubleStatusText.textContent = '2x, taşlar tamamen ayrıldıktan sonra teklif edilebilir';
    } else if (roomState.game.canOfferDouble) {
      doubleStatusText.textContent = '2x artık aktif, istersen teklif gönderebilirsin';
    } else {
      doubleStatusText.textContent = 'Rakibin sırasını veya zarın bitmesini bekle';
    }
  }
  if (doubleOfferBtn) {
    doubleOfferBtn.disabled = !socket.connected || !enemyConnected || !myTurn || !roomState.game.canOfferDouble || !!roomState.game.doubleOffer || roomState.game.winner || roomState.game.animating;
  }

  if (previousDoubleOffer && !roomState.game.doubleOffer) {
    const offererName = roomState.players?.[previousDoubleOffer.offeredBy]?.name || 'Rakip';
    if ((roomState.game.roundMultiplier || 1) > previousMultiplier) {
      showToast('2x kabul edildi. Bu el artık iki kat puan verecek.', 'success');
    } else if (!roomState.game.roundSummary && !roomState.game.matchSummary) {
      showToast(`2x reddedildi. ${offererName} 2 puanı aldı.`, 'warning');
    }
  }

  if (roomState.game.doubleOffer && roomState.game.doubleOffer.offeredBy !== state.me.color) showDoubleOffer(roomState.game.doubleOffer);
  else closeDoubleModal();

  if (roomState.game.roundSummary) showRoundSummary(roomState.game.roundSummary);
  else roundModal.classList.add('hidden');

  if (roomState.game.matchSummary) {
    showMatchSummary(roomState.game.matchSummary);
    const myVote = !!roomState.game.rematchVotes?.[state.me.color];
    const otherVote = !!roomState.game.rematchVotes?.[state.me.color === 'white' ? 'black' : 'white'];
    if (rematchBtn) {
      rematchBtn.disabled = myVote || !socket.connected || !enemyConnected;
      rematchBtn.textContent = myVote ? 'Rövanş istendi ✓' : 'Rövanş İste';
    }
    if (rematchStatusText) rematchStatusText.textContent = myVote
      ? 'Rakibin onayı bekleniyor...'
      : otherVote ? 'Rakibin rövanş istiyor. Sen de kabul edebilirsin.'
        : 'Yeni maç için iki oyuncunun onayı gerekir.';
  } else matchModal.classList.add('hidden');
  pruneSelection();
  autoSelectBarIfNeeded();
  renderDice();
  renderBoard();
  renderChat();
});

function pruneSelection() {
  if (!state.room || state.selectedFrom == null) return;
  if (state.selectedFrom === 'bar' && state.room.game.state.bar[state.me.color] > 0) return;
  if (state.selectedFrom !== 'bar' && ownCheckerAt(state.selectedFrom)) return;
  clearSelection();
}

function autoSelectBarIfNeeded() {
  if (!state.room || state.animating) return;
  if (state.room.game.turn !== state.me.color) return;
  if (state.room.game.state.bar[state.me.color] > 0) selectPoint('bar');
}

function canSelectPoint(pointIndex) {
  if (!state.room) return false;
  if (state.room.game.turn !== state.me.color) return false;
  if (!state.room.game.hasRolled || state.room.game.winner || state.animating || state.room.game.doubleOffer) return false;
  if (state.room.game.state.bar[state.me.color] > 0) return false;
  return ownCheckerAt(pointIndex);
}

function shouldPreferOption(next, current) {
  if (!current) return true;
  if (next.to === 'off' && current.to === 'off') {
    if (next.steps !== current.steps) return next.steps < current.steps;
    return Math.max(...next.diceUsed) > Math.max(...current.diceUsed);
  }
  if (next.steps !== current.steps) return next.steps > current.steps;
  return next.diceUsed.reduce((a, b) => a + b, 0) > current.diceUsed.reduce((a, b) => a + b, 0);
}

function selectPoint(from) {
  if (state.animating) return;
  if (state.selectedFrom === from) {
    clearSelection();
    renderBoard();
    return;
  }

  const options = getMyMoveOptions().filter((m) => String(m.from) === String(from));
  state.selectedFrom = from;
  state.possibleTargets = [];
  state.blockedTargets = [];
  state.actionMap = {};

  for (const option of options) {
    const key = String(option.to);
    const existing = state.actionMap[key];
    if (!existing || shouldPreferOption(option, existing)) state.actionMap[key] = option;
    if (!state.possibleTargets.includes(key)) state.possibleTargets.push(key);
  }

  state.blockedTargets = getBlockedTargetsForSelection(from, Object.values(state.actionMap));
  renderBoard();
}

function getBlockedTargetsForSelection(from, options) {
  const blocked = [];
  const added = new Set();
  const dice = state.room?.game?.dice || [];
  const possible = new Set(options.map((o) => String(o.to)));
  if (!dice.length) return blocked;

  for (const die of dice) {
    const target = destinationPoint(from, die);
    if (target >= 0 && target <= 23 && blockedByOpponent(target) && !possible.has(String(target)) && !added.has(String(target))) {
      blocked.push(String(target));
      added.add(String(target));
    }
  }

  return blocked;
}

function playMove(to) {
  if (state.selectedFrom == null || state.animating) return;
  const option = state.actionMap[String(to)];
  if (!option) return;
  socket.emit('move:play', { actionId: option.id, from: state.selectedFrom, to });
  clearSelection();
}

function renderBoard() {
  if (!state.room) return;
  const { points, off, bar: bars } = state.room.game.state;
  board.innerHTML = '';

  const leftColumn = document.createElement('div');
  leftColumn.className = 'halfColumn';
  leftColumn.appendChild(createHalf(perspectiveTopIndices().slice(0, 6), 'top', points));
  leftColumn.appendChild(createHalf(perspectiveBottomIndices().slice(0, 6), 'bottom', points));

  const rightColumn = document.createElement('div');
  rightColumn.className = 'halfColumn';
  rightColumn.appendChild(createHalf(perspectiveTopIndices().slice(6), 'top', points));
  rightColumn.appendChild(createHalf(perspectiveBottomIndices().slice(6), 'bottom', points));

  const middle = document.createElement('div');
  middle.className = 'middleBar';
  middle.appendChild(createBarZone(topPlayerColor(), 'top', bars[topPlayerColor()]));
  middle.appendChild(createBarZone(bottomPlayerColor(), 'bottom', bars[bottomPlayerColor()]));

  board.appendChild(createOffTray(topPlayerColor(), off[topPlayerColor()], 'top-right'));
  board.appendChild(createOffTray(bottomPlayerColor(), off[bottomPlayerColor()], 'bottom-right'));
  board.appendChild(leftColumn);
  board.appendChild(middle);
  board.appendChild(rightColumn);

  if (state.floatingChecker) board.appendChild(state.floatingChecker);
  updateBoardScale();
}

function createHalf(indices, side, points) {
  const half = document.createElement('div');
  half.className = 'half';

  indices.forEach((pointIndex, visualIndex) => {
    const point = document.createElement('div');
    const alt = visualIndex % 2 === 1 ? 'alt' : '';
    point.className = `point ${side} ${alt}`.trim();
    point.dataset.point = pointIndex;

    const label = document.createElement('div');
    label.className = 'pointLabel';
    label.textContent = pointIndex + 1;
    point.appendChild(label);

    const stack = document.createElement('div');
    stack.className = 'stack';
    const value = points[pointIndex];
    const count = Math.abs(value);
    const color = value > 0 ? 'white' : value < 0 ? 'black' : null;
    const canSelectPointNow = canSelectPoint(pointIndex);
    const visibleCount = Math.min(count, 5);

    for (let i = 0; i < visibleCount; i++) {
      const checker = document.createElement('div');
      checker.className = `checker ${color || ''}`.trim();
      checker.style.setProperty('--checker-image', color ? `url(${currentSkinAsset(color)})` : 'none');
      if (i === visibleCount - 1 && canSelectPointNow) {
        checker.classList.add('clickable');
        checker.addEventListener('click', (event) => {
          event.stopPropagation();
          selectPoint(pointIndex);
        });
      }
      stack.appendChild(checker);
    }

    if (count > 5) {
      const badge = document.createElement('div');
      badge.className = 'stackCountBadge';
      badge.textContent = count;
      stack.appendChild(badge);
    }

    point.appendChild(stack);
    if (String(state.selectedFrom) === String(pointIndex)) point.classList.add('selected');

    if (state.possibleTargets.includes(String(pointIndex))) {
      point.classList.add('possible');
      const option = state.actionMap[String(pointIndex)];
      if (option?.steps > 1) point.dataset.steps = option.steps;
      point.addEventListener('click', () => playMove(pointIndex));
    } else if (canSelectPointNow) {
      point.classList.add('selectableColumn');
      point.addEventListener('click', () => selectPoint(pointIndex));
    }

    if (state.blockedTargets.includes(String(pointIndex))) point.classList.add('blocked');
    half.appendChild(point);
  });

  return half;
}

function createBarZone(color, placement, count) {
  const zone = document.createElement('div');
  zone.className = `barZone ${placement}`;
  zone.dataset.color = color;
  if (count > 0) {
    const checker = document.createElement('div');
    checker.className = `checker ${color} barChecker`;
    checker.style.setProperty('--checker-image', `url(${currentSkinAsset(color)})`);
    zone.appendChild(checker);
    if (count > 1) {
      const badge = document.createElement('div');
      badge.className = 'barBadge';
      badge.textContent = count;
      zone.appendChild(badge);
    }
  }
  if (state.selectedFrom === 'bar' && color === state.me.color) zone.classList.add('selectedCounter');
  if (color === state.me.color && count > 0 && getMyMoveOptions().some((m) => String(m.from) === 'bar')) {
    zone.classList.add('actionable');
    zone.addEventListener('click', () => selectPoint('bar'));
  }
  return zone;
}

function createOffTray(color, count, placement) {
  const tray = document.createElement('div');
  tray.className = `offTray ${placement}`;
  tray.dataset.color = color;
  const visible = Math.min(count, 6);
  for (let i = 0; i < visible; i++) {
    const checker = document.createElement('div');
    checker.className = `checker ${color} offChecker`;
    checker.style.setProperty('--checker-image', `url(${currentSkinAsset(color)})`);
    checker.style.setProperty('--off-index', i);
    tray.appendChild(checker);
  }
  if (count > 6) {
    const more = document.createElement('div');
    more.className = 'offCountBadge';
    more.textContent = count;
    tray.appendChild(more);
  }
  if (color === state.me.color && state.possibleTargets.includes('off')) {
    tray.classList.add('possible', 'selectedCounter', 'actionable');
    tray.addEventListener('click', () => playMove('off'));
  }
  return tray;
}

function renderDice() {
  const game = state.room?.game;
  diceArea.innerHTML = '';
  const showRolling = state.diceAnimating && !game?.hasRolled && !(game?.dice?.length);
  if (!showRolling && state.diceAnimating) stopDiceAnimation();
  const baseDice = showRolling ? state.diceAnimationValues : (game?.turnStartDice || []);
  if (!baseDice.length) {
    diceArea.innerHTML = `<div class="muted">${t('waitingForDice')}</div>`;
    return;
  }

  if (showRolling) {
    baseDice.forEach((value, idx) => {
      const die = createDieCube(value, false, true, idx);
      diceArea.appendChild(die);
    });
    return;
  }

  const remaining = countByValue(game?.dice || []);
  baseDice.forEach((value) => {
    const current = remaining.get(value) || 0;
    const die = createDieFlat(value, current <= 0);
    diceArea.appendChild(die);
    if (current > 0) remaining.set(value, current - 1);
  });
}

function buildPips(face, value) {
  const patterns = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
  };
  const positions = patterns[value] || [];
  for (const pos of positions) {
    const pip = document.createElement('span');
    pip.className = `pip p${pos}`;
    face.appendChild(pip);
  }
}

function faceRotationForValue(value) {
  const map = {
    1: 'rotateX(0deg) rotateY(0deg)',
    2: 'rotateX(-90deg) rotateY(0deg)',
    3: 'rotateY(90deg)',
    4: 'rotateY(-90deg)',
    5: 'rotateX(90deg)',
    6: 'rotateY(180deg)'
  };
  return map[value] || map[1];
}


function createDieFlat(value, used = false) {
  const wrap = document.createElement('div');
  wrap.className = `dieFlat ${used ? 'used' : ''}`;
  const img = document.createElement('img');
  img.className = 'dieImage static';
  img.alt = `Zar ${value}`;
  img.src = `assets/dice/${value}.svg`;
  wrap.appendChild(img);
  return wrap;
}

function createDieCube(value, used = false, rolling = false, index = 0) {
  const wrap = document.createElement('div');
  wrap.className = `dieWrap ${used ? 'used' : ''} ${rolling ? 'rollingWrap' : ''}`;
  const cube = document.createElement('div');
  cube.className = `dieCube ${rolling ? 'rolling' : ''}`;
  if (!rolling) {
    cube.style.transform = faceRotationForValue(value);
  } else {
    cube.style.setProperty('--spin-x', `${900 + Math.floor(Math.random()*360) + index*120}deg`);
    cube.style.setProperty('--spin-y', `${720 + Math.floor(Math.random()*360) + index*160}deg`);
    cube.style.setProperty('--spin-z', `${540 + Math.floor(Math.random()*360)}deg`);
  }

  const faces = [
    ['front', 1], ['back', 6], ['right', 3], ['left', 4], ['top', 5], ['bottom', 2]
  ];
  for (const [name, faceValue] of faces) {
    const face = document.createElement('div');
    face.className = `dieFace ${name}`;
    buildPips(face, faceValue);
    cube.appendChild(face);
  }
  wrap.appendChild(cube);
  return wrap;
}

function randomDieValue() {
  return 1 + Math.floor(Math.random() * 6);
}

function stopDiceAnimation() {
  state.diceAnimating = false;
  if (state.diceAnimationTimer) {
    clearInterval(state.diceAnimationTimer);
    state.diceAnimationTimer = null;
  }
}

function startDiceAnimation(duration = 1850) {
  stopDiceAnimation();
  state.diceAnimating = true;
  state.diceAnimationValues = [randomDieValue(), randomDieValue()];
  renderDice();
  playSound('roll');

  state.diceAnimationTimer = setInterval(() => {
    state.diceAnimationValues = [randomDieValue(), randomDieValue()];
    renderDice();
  }, 280);

  setTimeout(() => {
    stopDiceAnimation();
    renderDice();
  }, duration);
}

function getAnchorForLocation(loc, color) {
  let el;
  if (loc === 'bar') {
    el = board.querySelector(`.barZone[data-color="${color}"]`);
  } else if (loc === 'off') {
    el = board.querySelector(`.offTray[data-color="${color}"]`);
  } else {
    el = board.querySelector(`.point[data-point="${loc}"]`);
  }
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  return {
    x: rect.left - boardRect.left + rect.width / 2,
    y: rect.top - boardRect.top + rect.height / 2
  };
}

function makeFloatingChecker(color, fromPos) {
  const checker = document.createElement('div');
  checker.className = `checker ${color} floatingChecker`;
  checker.style.setProperty('--checker-image', `url(${currentSkinAsset(color)})`);
  const reference = board.querySelector('.point .checker, .barZone .checker, .offTray .checker');
  const size = reference?.getBoundingClientRect().width || 56;
  checker.style.width = `${size}px`;
  checker.style.height = `${size}px`;
  checker.style.left = `${fromPos.x - size / 2}px`;
  checker.style.top = `${fromPos.y - size / 2}px`;
  return checker;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function animateMove(color, path) {
  if (!board.isConnected) return;
  let currentPos = getAnchorForLocation(path[0].from, color);
  if (!currentPos) return;
  const floating = makeFloatingChecker(color, currentPos);
  state.floatingChecker = floating;
  board.appendChild(floating);

  for (const step of path) {
    const targetPos = getAnchorForLocation(step.to, color);
    if (!targetPos) continue;
    floating.style.transition = 'left 260ms ease, top 260ms ease';
    requestAnimationFrame(() => {
      const halfSize = floating.offsetWidth / 2;
      floating.style.left = `${targetPos.x - halfSize}px`;
      floating.style.top = `${targetPos.y - halfSize}px`;
    });
    await wait(280);
    currentPos = targetPos;
  }

  await wait(80);
  floating.remove();
  state.floatingChecker = null;
}


requestAnimationFrame(updateBoardScale);
