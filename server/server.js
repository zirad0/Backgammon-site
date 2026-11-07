const path = require('path');
const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { loadSnapshot, saveSnapshot } = require('./storage');
const { Accounts, SESSION_MAX_AGE_MS, publicUser, tokenHash, readCookie } = require('./accounts');
const { Server } = require('socket.io');
const {
  createMatch,
  createInitialState,
  cloneState,
  opponent,
  rollDice,
  legalMoveOptions,
  applyMove,
  hasAnyLegalMove,
  isGameWon,
  getRoundPoints,
  arePlayersSeparated
} = require('./game');

const app = express();
const server = http.createServer(app);
// WebSocket'ler için aynı-origin kuralı; farklı güvenilir origin'ler açıkça izinlenebilir.
// Origin başlığı olmayan sunucu istemcilerine izin verilir; bu mekanizma kullanıcı kimlik doğrulaması DEĞİLDİR.
function checkSocketOrigin(request, callback) {
  const origin = request.headers?.origin;
  if (!origin) return callback(null, true);
  try {
    if (origin.length > 2048) return callback('Geçersiz kaynak.', false);
    const parsed = new URL(origin);
    const ownHost = request.headers?.host;
    const extras = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    const allowed = ['http:', 'https:'].includes(parsed.protocol) &&
      (parsed.host === ownHost || extras.includes(parsed.origin));
    return callback(allowed ? null : 'Kaynağa izin verilmiyor.', allowed);
  } catch {
    return callback('Geçersiz kaynak.', false);
  }
}
const io = new Server(server, { maxHttpBufferSize: 64 * 1024, allowRequest: checkSocketOrigin });
if (io.engine?.on) io.engine.on('connection_error', error =>
  logEvent('warn', 'websocket_connection_refused', { code: error.code }));

function logEvent(level, event, details = {}) {
  // Herkese açık konsol loglarına gizli oyuncu tokenları veya DB URL'si yazılmaz.
  const entry = { at: new Date().toISOString(), level, event };
  if (details.code) entry.code = String(details.code).slice(0, 64);
  if (details.message) entry.message = String(details.message)
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgres://[REDACTED]@')
    .slice(0, 220);
  (typeof console[level] === 'function' ? console[level] : console.log)(JSON.stringify(entry));
}
let databaseStore = null;
let databaseReady = !process.env.DATABASE_URL;
const databaseConfigured = !!process.env.DATABASE_URL;
function isStorageReady() { return databaseConfigured ? !!(databaseReady && databaseStore?.healthy) : true; }
function onProtected(socket, event, handler) {
  socket.on(event, (...args) => {
    if (!isStorageReady()) {
      socket.emit('room:error', 'Kayıt sunucusuna erişilemiyor. Maç güvenliği için işlemler duraklatıldı.');
      return;
    }
    try { return handler(...args); }
    catch (error) {
      logEvent('error', 'socket_handler_failed', { code: event, message: error.message });
      socket.emit('room:error', 'İşlem gerçekleştirilemedi. Tekrar deneyin.');
    }
  });
}
const PORT = Number(process.env.PORT) || 3000;
const ROOM_IDLE_EXPIRY_MS = 60 * 60 * 1000; // 1 saat boyunca iki oyuncu da yoksa oda silinir.
const PUBLIC_LOBBY_CHANNEL = 'public-lobby';
const MAX_SPECTATORS_PER_ROOM = 60;
function viewerChannel(roomCode) { return `watch:${roomCode}`; }
const MAX_ROOMS = 200; // Hobi sunucusunu sınırsız oda oluşturmaktan korur.
const DOUBLE_OFFER_WINDOW_MS = 2700;
const RECONNECT_GRACE_MS = 15 * 60 * 1000; // 15 dakika bağlantı kurtarma süresi

function clearGameTimers(game) {
  if (game.autoRollTimer) clearTimeout(game.autoRollTimer);
  if (game.moveTimer) clearTimeout(game.moveTimer);
  game.autoRollTimer = null;
  game.moveTimer = null;
  game.diceRolling = false;
  game.animating = false; // Yarım animasyon tekrar bağlanınca güvenle tekrar oynanabilir.
}

function bothPlayersOnline(room) {
  return !!(room?.players.white?.connected && room?.players.black?.connected);
}


app.disable('x-powered-by');
// Render gibi tek ters vekil kullanan dağıtımlarda istemci IP'siyle hız sınırı uygulansın.
if (typeof app.set === 'function' && process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.get('/health', (_req, res) => {
  const ok = isStorageReady();
  res.status(ok ? 200 : 503).json({ ok, version: 'v16', storage: databaseConfigured ? 'postgres' : 'file' });
});
// Oturum yalnızca HttpOnly SameSite cookie'den okunur; tarayıcı JS'si oturum anahtarını göremez.
const authRate = new Map();
function allowAuthAttempt(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = (authRate.get(ip) || []).filter(time => now - time < 15 * 60_000);
  if (bucket.length >= 12) return false;
  bucket.push(now);
  authRate.set(ip, bucket);
  if (authRate.size > 5000) for (const [key, events] of authRate) {
    if (events.every(time => now - time > 15 * 60_000)) authRate.delete(key);
  }
  return true;
}
function allowSameOriginMutation(req) {
  const origin = req.get?.('origin');
  if (origin) {
    try {
      const ownProtocol = req.protocol || 'http';
      const ownOrigin = `${ownProtocol}://${req.get('host')}`;
      if (new URL(origin).origin !== ownOrigin) return false;
    }
    catch { return false; }
  }
  const site = req.get?.('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  return !!req.is?.('application/json');
}
function sessionCookie(req, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `tavla_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function getHttpAccount(req) {
  return accounts.resolveToken(readCookie(req.headers?.cookie));
}
function getProfile(account) {
  return { authenticated: true, user: publicUser(account), stats: getAccountStats(account.id),
    recentMatches: getAccountRecentMatches(account.id) };
}
if (typeof express.json === 'function') app.use('/api/auth', express.json({ limit: '2kb' }));
if (typeof app.post === 'function') {
  for (const kind of ['register', 'login']) app.post(`/api/auth/${kind}`, async (req, res) => {
    if (!allowSameOriginMutation(req)) return res.status(403).json({ error: 'Geçersiz istek kaynağı veya içerik tipi.' });
    if (!isStorageReady()) return res.status(503).json({ error: 'Veritabanına erişilemiyor.' });
    if (!allowAuthAttempt(req)) return res.status(429).json({ error: 'Çok fazla giriş denemesi. Daha sonra tekrar dene.' });
    try {
      const { username, password } = req.body || {};
      const result = kind === 'register' ? accounts.register(username, password) : accounts.login(username, password);
      await persistAll();
      res.setHeader('Set-Cookie', sessionCookie(req, result.token, Math.floor(SESSION_MAX_AGE_MS / 1000)));
      return res.json(getProfile(accounts.resolveToken(result.token)));
    } catch (error) {
      if (error.message === 'Kullanıcı adı veya şifre yanlış.') return res.status(401).json({ error: error.message });
      if (['Bu kullanıcı adı zaten kullanılıyor.', 'Şifre 8–128 karakter olmalı.',
        'Kullanıcı adı 3–20 karakter olmalı; yalnızca harf, rakam ve _ kullanılabilir.'].includes(error.message))
        return res.status(400).json({ error: error.message });
      logEvent('error', 'account_write_failed', { message: error.message });
      return res.status(503).json({ error: 'Hesap şu anda kaydedilemiyor.' });
    }
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (!allowSameOriginMutation(req)) return res.status(403).json({ error: 'Geçersiz istek.' });
    if (!isStorageReady()) return res.status(503).json({ error: 'Veritabanına erişilemiyor.' });
    accounts.revokeToken(readCookie(req.headers?.cookie));
    try { await persistAll(); }
    catch { return res.status(503).json({ error: 'Çıkış kaydedilemedi.' }); }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return res.json({ authenticated: false });
  });
}
app.get('/api/me', (req, res) => {
  if (!isStorageReady()) return res.status(503).json({ error: 'Veritabanına erişilemiyor.' });
  const account = getHttpAccount(req);
  res.setHeader('Cache-Control', 'no-store');
  return res.json(account ? getProfile(account) : { authenticated: false });
});
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use((error, _req, res, _next) => {
  logEvent('error', 'http_request_failed', { code: error.code, message: error.message });
  if (!res.headersSent) res.status(500).json({ error: 'Sunucu hatası.' });
});

const rooms = new Map();
const accounts = new Accounts();
const matchHistory = [];
let nextChatId = 1;
let nextSummaryId = 1;

// Sunucu tek otoritedir. Sadece doğrulanmış hamleler ve sunucu zarları kaydedilir.
// Oyuncu tokenları ve oda anlık görüntüleri client klasörüne ASLA yazılmaz.
function persistAll() {
  const snapshot = {
    version: 1,
    nextChatId,
    nextSummaryId,
    history: matchHistory,
    ...accounts.serialize(),
    rooms: [...rooms.entries()].map(([roomCode, room]) => ({
      roomCode,
      players: Object.fromEntries(['white', 'black'].map(color => {
        const player = room.players[color];
        return [color, player ? {
          name: player.name, playerToken: player.playerToken, autoDice: player.autoDice,
          accountId: player.accountId || null,
          disconnectedAt: player.disconnectedAt || null
        } : null];
      })),
      chat: room.chat,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators === true,
      hasStarted: room.hasStarted,
      matchId: room.matchId,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      game: { ...room.game, autoRollTimer: null, moveTimer: null, animating: false, diceRolling: false }
    }))
  };
  if (databaseStore) {
    const pending = databaseStore.save(snapshot);
    // Kuyruktaki yazı tamamlanmadan yapılan işlem başarılı ilan edilmez.
    pending.catch(error => logEvent('error', 'snapshot_save_cancelled', { message: error.message }));
    return pending;
  }
  saveSnapshot(snapshot);
  return null;
}

function archiveMatch(room, status = 'finished') {
  if (!room.hasStarted || room.game.archiveId) return;
  const game = room.game;
  const record = {
    id: room.matchId || crypto.randomUUID(),
    status,
    finishedAt: Date.now(),
    players: {
      white: room.players.white?.name || 'Beyaz',
      black: room.players.black?.name || 'Siyah'
    },
    playerTokens: [room.players.white?.playerToken, room.players.black?.playerToken].filter(Boolean),
    userIds: { white: room.players.white?.accountId || null, black: room.players.black?.accountId || null },
    winner: status === 'finished' ? game.winner : null,
    scores: { ...game.scores },
    targetScore: game.targetScore
  };
  game.archiveId = record.id;
  matchHistory.push(record);
  if (matchHistory.length > 1000) matchHistory.splice(0, matchHistory.length - 1000);
  for (const player of [room.players.white, room.players.black]) {
    const playerSocket = player?.socketId && io.sockets.sockets.get(player.socketId);
    if (playerSocket) sendHistory(playerSocket, player.playerToken);
  }
}

function getAccountStats(accountId) {
  const completed = matchHistory.filter(match => match.status === 'finished' &&
    Object.values(match.userIds || {}).includes(accountId));
  const wins = completed.filter(match => match.userIds?.[match.winner] === accountId).length;
  const losses = completed.length - wins;
  return { games: completed.length, wins, losses,
    winRate: completed.length ? Math.round(wins * 1000 / completed.length) / 10 : 0 };
}
function getAccountRecentMatches(accountId) {
  return matchHistory.filter(match => Object.values(match.userIds || {}).includes(accountId))
    .slice(-15).reverse().map(({ playerTokens, userIds, ...record }) => record);
}
function sendHistory(socket, token) {
  const account = getSocketAccount(socket);
  const records = matchHistory.filter(match =>
    (account && Object.values(match.userIds || {}).includes(account.id)) ||
    (typeof token === 'string' && token.length >= 32 && token.length <= 100 &&
      Array.isArray(match.playerTokens) && match.playerTokens.includes(token)));
  socket.emit('history:list', records.slice(-15).reverse()
    .map(({ playerTokens, userIds, ...record }) => record));
  if (account) socket.emit('account:profile', { user: publicUser(account), stats: getAccountStats(account.id) });
}

function removeRoom(roomCode, room, reason) {
  if (rooms.get(roomCode) !== room) return;
  clearGameTimers(room.game);
  for (const timer of Object.values(room.reconnectTimers || {})) clearTimeout(timer);
  archiveMatch(room, room.game.winner ? 'finished' : 'interrupted');
  rooms.delete(roomCode);
  const saved = persistAll();
  const notify = () => {
    broadcastOpenPublicRooms();
    io.to(roomCode).emit('room:closed', { reason });
    io.to(viewerChannel(roomCode)).emit('room:closed', { reason });
    for (const viewerId of room.spectators || []) {
      const viewer = io.sockets.sockets.get(viewerId);
      if (viewer) { viewer.leave(viewerChannel(roomCode)); viewer.data.watchingRoom = null; }
    }
    room.spectators?.clear();
    for (const player of [room.players.white, room.players.black]) {
      const memberSocket = player?.socketId && io.sockets.sockets.get(player.socketId);
      if (memberSocket) memberSocket.leave(roomCode);
    }
  };
  if (saved) saved.then(notify);
  else notify();
}

function stopReconnectTimer(room, color) {
  if (room.reconnectTimers?.[color]) clearTimeout(room.reconnectTimers[color]);
  if (room.reconnectTimers) room.reconnectTimers[color] = null;
  if (room.players[color]) room.players[color].disconnectedAt = null;
}

function startReconnectTimer(roomCode, room, color) {
  if (!room.players[color] || room.players[color].connected) return;
  if (!room.reconnectTimers) room.reconnectTimers = {};
  if (room.reconnectTimers[color]) clearTimeout(room.reconnectTimers[color]);
  const startedAt = room.players[color].disconnectedAt || Date.now();
  room.players[color].disconnectedAt = startedAt;
  const remaining = Math.max(0, RECONNECT_GRACE_MS - (Date.now() - startedAt));
  room.reconnectTimers[color] = setTimeout(() => {
    room.reconnectTimers[color] = null;
    if (rooms.get(roomCode) !== room || room.players[color]?.connected) return;
    removeRoom(roomCode, room, 'Oyuncu 15 dakika içinde yeniden bağlanamadığı için oda kapatıldı.');
  }, remaining);
}

function restoreSavedRooms(saved) {
  if (!saved) return;
  accounts.restore(saved.users, saved.sessions);
  nextChatId = Math.max(1, Number(saved.nextChatId) || 1);
  nextSummaryId = Math.max(1, Number(saved.nextSummaryId) || 1);
  for (const history of saved.history.slice(-1000)) {
    if (history && Array.isArray(history.playerTokens)) matchHistory.push(history);
  }
  for (const data of saved.rooms) {
    if (!data || typeof data.roomCode !== 'string' || !data.players?.white?.playerToken || !data.game?.state) continue;
    const players = Object.fromEntries(['white', 'black'].map(color => {
      const member = data.players[color];
      return [color, member ? {
        name: sanitizeName(member.name, 'Oyuncu'),
        playerToken: member.playerToken, accountId: member.accountId || null,
        autoDice: member.autoDice !== false,
        connected: false, socketId: null,
        disconnectedAt: member.disconnectedAt || Date.now()
      } : null];
    }));
    const room = {
      players,
      chat: Array.isArray(data.chat) ? data.chat.slice(-120) : [],
      visibility: data.visibility === 'public' ? 'public' : 'private',
      allowSpectators: data.allowSpectators === true,
      spectators: new Set(),
      hasStarted: !!data.hasStarted,
      matchId: data.matchId || crypto.randomUUID(),
      createdAt: Number(data.createdAt) || Date.now(),
      lastActivityAt: Number(data.lastActivityAt) || Date.now(),
      reconnectTimers: {},
      game: { ...createMatch(data.game.targetScore), ...data.game,
        autoRollTimer: null, moveTimer: null, animating: false,
        diceRolling: false, doubleOffer: null }
    };
    if (rooms.size >= MAX_ROOMS) break;
    rooms.set(data.roomCode, room);
  }
  // Bir sunucu yeniden başlaması, 2x teklifini ve animasyonları duraklatır.
  // İki oyuncu tekrar bağlanırsa sıra/zar/taşlar aynen devam eder.
  for (const [roomCode, room] of rooms) {
    for (const color of ['white', 'black']) startReconnectTimer(roomCode, room, color);
  }
}
// Yerelde dosya deposu eşzamanlı olarak yüklenir; PostgreSQL ise dinleyici açılmadan önce yüklenir.
if (!databaseConfigured) restoreSavedRooms(loadSnapshot());

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}


function sameToken(player, token) {
  return !!player && !!token && player.playerToken === token;
}

function attachPlayer(player, socketId, name, token, autoDice, accountId = undefined) {
  player.socketId = socketId;
  player.connected = true;
  player.disconnectedAt = null;
  if (name) player.name = sanitizeName(name, player.name || 'Oyuncu');
  if (token) player.playerToken = token;
  if (typeof autoDice === 'boolean') player.autoDice = autoDice;
  if (accountId !== undefined) player.accountId = accountId;
  if (typeof player.autoDice !== 'boolean') player.autoDice = true;
  return player;
}

function findPlayerRoomByAccountId(accountId) {
  if (!accountId) return null;
  for (const [roomCode, room] of rooms) {
    for (const color of ['white', 'black']) {
      if (room.players[color]?.accountId === accountId) return { roomCode, room, color };
    }
  }
  return null;
}

function findPlayerRoomByToken(playerToken) {
  if (!playerToken) return null;
  for (const [roomCode, room] of rooms.entries()) {
    for (const key of ['white', 'black']) {
      if (room.players[key]?.playerToken === playerToken) {
        return { roomCode, room, color: key };
      }
    }
  }
  return null;
}


function canRoll(room) {
  const game = room?.game;
  return !!(isStorageReady() && game && !game.winner && !game.animating && !game.pendingState &&
    !game.doubleOffer && bothPlayersOnline(room));
}

function performAutoRoll(roomCode) {
  const room = rooms.get(roomCode);
  if (!canRoll(room)) return;
  const game = room.game;
  const rolled = rollDice();
  game.rolledPair = rolled.pair;
  game.dice = rolled.dice;
  game.pendingState = cloneState(game.state);
  game.turnStartState = cloneState(game.state);
  game.turnStartDice = [...rolled.dice];
  game.movedThisTurn = false;
  game.diceRolling = false;
  game.autoRollTimer = null;
  emitRoomState(roomCode);
}

function maybeStartTurnRoll(roomCode, delay = 900) {
  const room = rooms.get(roomCode);
  if (!canRoll(room)) return;
  const game = room.game;
  if (!room.players[game.turn]?.autoDice) return;
  // Temasın kalmadığı aşamada otomatik zar, 2x için bir karar penceresi bırakır.
  const offerWindow = canOfferDouble(room) ? DOUBLE_OFFER_WINDOW_MS : 0;
  scheduleAutoRoll(roomCode, Math.max(delay, offerWindow));
}

function scheduleAutoRoll(roomCode, delay = 900) {
  const room = rooms.get(roomCode);
  if (!canRoll(room)) return;
  const game = room.game;
  if (game.autoRollTimer || game.diceRolling) return;

  // Zar animasyonundan ÖNCE bekle: 2x teklifleri animasyonla yarışmasın.
  game.autoRollTimer = setTimeout(() => {
    game.autoRollTimer = null;
    if (rooms.get(roomCode) !== room || !canRoll(room)) return;
    game.diceRolling = true;
    io.to(roomCode).emit('dice:rolling', { color: game.turn, duration: 650 });
    io.to(viewerChannel(roomCode)).emit('dice:rolling', { color: game.turn, duration: 650 });
    game.autoRollTimer = setTimeout(() => {
      game.autoRollTimer = null;
      if (rooms.get(roomCode) === room) performAutoRoll(roomCode);
    }, 650);
  }, delay);
}

function displaceOldSocket(roomCode, player, newSocketId) {
  if (!player?.socketId || player.socketId === newSocketId) return;
  const oldSocket = io.sockets.sockets.get(player.socketId);
  if (oldSocket) {
    oldSocket.emit('room:session-taken');
    oldSocket.leave(roomCode);
  }
}

function preventMultipleRooms(socket, playerToken, requestedCode = null) {
  const active = findPlayerRoom(socket.id);
  const byToken = findPlayerRoomByToken(playerToken);
  const byAccount = findPlayerRoomByAccountId(getSocketAccount(socket)?.id);
  if ((byAccount && byAccount.roomCode !== requestedCode) || (active && active.roomCode !== requestedCode) || (byToken && byToken.roomCode !== requestedCode)) {
    socket.emit('room:error', 'Önce açık olan odandan ayrılmalısın.');
    return true;
  }
  return false;
}

function sanitizeName(name, fallback) {
  const trimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  return trimmed.slice(0, 20) || fallback;
}

function allowSocketAction(socket, type, limit = 16, periodMs = 1000) {
  if (!socket.data.eventBuckets) socket.data.eventBuckets = {};
  const now = Date.now();
  const bucket = (socket.data.eventBuckets[type] || []).filter(time => now - time < periodMs);
  socket.data.eventBuckets[type] = bucket;
  if (bucket.length >= limit) return false;
  bucket.push(now);
  return true;
}

function publicPlayer(player) {
  if (!player) return null;
  // playerToken ve socketId asla diğer oyunculara gönderilmemeli.
  return { name: player.name, connected: player.connected, autoDice: player.autoDice,
    reconnectUntil: !player.connected && player.disconnectedAt ? player.disconnectedAt + RECONNECT_GRACE_MS : null };
}

function refreshRoomActivity(room) {
  room.lastActivityAt = Date.now();
}

function createRoomModel(score, creatorSocketId, creatorName, creatorToken, creatorAutoDice = true, visibility = 'private', accountId = null, allowSpectators = false) {
  return {
    players: {
      white: { socketId: creatorSocketId, name: sanitizeName(creatorName, 'Oyuncu 1'), connected: true, playerToken: creatorToken || null, accountId, autoDice: creatorAutoDice !== false },
      black: null
    },
    chat: [],
    visibility: visibility === 'public' ? 'public' : 'private',
    allowSpectators: allowSpectators === true,
    spectators: new Set(),
    hasStarted: false,
    matchId: crypto.randomUUID(),
    reconnectTimers: {},
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    game: createMatch(score)
  };
}

// Yalnızca henüz maç başlamamış, kurucusu bağlı, bir oyunculu herkese açık odaları listele.
// Özel odalar ve devam eden/bitmiş maçlar bu olayla ASLA paylaşılmaz.
function listOpenPublicRooms() {
  return [...rooms.entries()]
    .filter(([, room]) => room.visibility === 'public' && !room.hasStarted &&
      room.players.white?.connected && !room.players.black)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .map(([roomCode, room]) => ({
      roomCode,
      targetScore: room.game.targetScore,
      playerCount: 1,
      maxPlayers: 2,
      players: [{ name: room.players.white.name, color: 'white' }]
    }));
}

function listSpectatablePublicMatches() {
  return [...rooms.entries()]
    .filter(([, room]) => room.visibility === 'public' && room.allowSpectators === true &&
      room.hasStarted && room.players.white && room.players.black && !room.game.winner)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .map(([roomCode, room]) => ({
      roomCode,
      players: { white: room.players.white.name, black: room.players.black.name },
      scores: { ...room.game.scores },
      targetScore: room.game.targetScore,
      spectatorCount: room.spectators?.size || 0
    }));
}
function broadcastSpectatableMatches() {
  io.to(PUBLIC_LOBBY_CHANNEL).emit('matches:list', listSpectatablePublicMatches());
}
function broadcastOpenPublicRooms() {
  io.to(PUBLIC_LOBBY_CHANNEL).emit('rooms:list', listOpenPublicRooms());
  broadcastSpectatableMatches();
}
function updateSpectatorCount(roomCode, room) {
  const spectatorCount = room.spectators?.size || 0;
  io.to(roomCode).emit('viewer:count', { spectatorCount });
  io.to(viewerChannel(roomCode)).emit('viewer:count', { spectatorCount });
  if (room.visibility === 'public' && room.hasStarted) broadcastSpectatableMatches();
}
function stopWatching(socket) {
  const roomCode = socket.data.watchingRoom;
  if (!roomCode) return;
  socket.leave(viewerChannel(roomCode));
  socket.data.watchingRoom = null;
  const room = rooms.get(roomCode);
  if (room && room.spectators.delete(socket.id)) updateSpectatorCount(roomCode, room);
}


function pushChatMessage(room, color, name, text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  if (!clean) return null;
  const message = {
    id: nextChatId++,
    color,
    name,
    text: clean,
    timestamp: Date.now()
  };
  room.chat.push(message);
  refreshRoomActivity(room);
  if (room.chat.length > 120) room.chat.shift();
  return message;
}

function resetRoomForRematch(room) {
  const previousWinner = room.game.winner;
  const targetScore = room.game.targetScore;
  clearGameTimers(room.game);
  room.game = createMatch(targetScore);
  room.matchId = crypto.randomUUID();
  room.game.turn = previousWinner || 'white';
}

function canOfferDouble(room) {
  const game = room?.game;
  if (!room || !game) return false;
  if (!bothPlayersOnline(room) || !isStorageReady()) return false;
  if (game.winner || game.animating || game.pendingState || game.diceRolling) return false;
  if (game.doubleOffer || game.roundMultiplier !== 1) return false;
  return arePlayersSeparated(game.state);
}

function awardRoundTo(roomCode, room, winner, { multiplierOverride = null, reasonText = null, forcedPoints = null } = {}) {
  const game = room.game;
  const winnerName = winner === 'white' ? (room.players.white?.name || 'Beyaz') : (room.players.black?.name || 'Siyah');
  clearGameTimers(game);
  const computedBasePoints = getRoundPoints(game.state, winner);
  const basePoints = forcedPoints ?? computedBasePoints;
  const multiplier = forcedPoints != null ? 1 : (multiplierOverride || game.roundMultiplier || 1);
  const totalPoints = forcedPoints ?? (basePoints * multiplier);

  game.roundSummary = {
    id: nextSummaryId++,
    text: reasonText || `${winnerName} bu eli kazandı. ${basePoints} puan x ${multiplier} = ${totalPoints} puan aldı.`
  };
  game.scores[winner] += totalPoints;
  pushChatMessage(room, 'system', 'Sistem', `${winnerName} bu eli kazandı ve ${totalPoints} puan aldı.`);
  game.doubleOffer = null;
  game.roundMultiplier = 1;
  game.pendingState = null;
  game.dice = [];
  game.rolledPair = null;
  game.turnStartDice = [];
  game.turnStartState = null;
  game.movedThisTurn = false;

  if (game.scores[winner] >= game.targetScore) {
    game.winner = winner;
    broadcastSpectatableMatches();
    game.rematchVotes = { white: false, black: false };
    game.matchSummary = {
      id: nextSummaryId++,
      text: `${winnerName} maçı kazandı! Rövanş ister misiniz?`
    };
    archiveMatch(room, 'finished');
  }

  game.state = createInitialState();
  game.turn = winner; // Yeni eli kazanan başlatır.
}

function buildPublicState(roomCode, room) {
  const game = room.game;
  const activeState = game.pendingState || game.state;
  const moveOptions = game.pendingState ? legalMoveOptions(game.pendingState, game.turn, game.dice) : [];
  const noMovesAvailable = game.pendingState ? !hasAnyLegalMove(game.pendingState, game.turn, game.dice) : false;
  const hasRemainingMoves = moveOptions.length > 0;

  return {
    roomCode,
    visibility: room.visibility,
    allowSpectators: room.allowSpectators === true,
    spectatorCount: room.spectators?.size || 0,
    players: { white: publicPlayer(room.players.white), black: publicPlayer(room.players.black) },
    game: {
      turn: game.turn,
      scores: game.scores,
      targetScore: game.targetScore,
      winner: game.winner,
      dice: game.dice,
      rolledPair: game.rolledPair,
      turnStartDice: game.turnStartDice || [],
      state: activeState,
      moveOptions,
      canConfirm: !!game.pendingState && (!hasRemainingMoves && (game.movedThisTurn || noMovesAvailable || game.dice.length === 0)),
      hasRolled: !!game.pendingState,
      waitingForRoll: !game.pendingState && !game.diceRolling,
      diceRolling: !!game.diceRolling,
      noMovesAvailable,
      movedThisTurn: game.movedThisTurn,
      roundSummary: game.roundSummary || null,
      matchSummary: game.matchSummary || null,
      animating: !!game.animating,
      roundMultiplier: game.roundMultiplier || 1,
      noContactPhase: arePlayersSeparated(activeState),
      canOfferDouble: canOfferDouble(room),
      doubleOffer: game.doubleOffer || null,
      rematchVotes: game.rematchVotes || { white: false, black: false }
    },
    chat: room.chat || []
  };
}

function buildSpectatorState(roomCode, room) {
  const state = buildPublicState(roomCode, room);
  // İzleyiciler özel sohbetleri, hamle önerilerini veya onay imkânlarını alamaz.
  state.chat = [];
  state.game.moveOptions = [];
  state.game.canConfirm = false;
  state.game.canOfferDouble = false;
  return state;
}

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  refreshRoomActivity(room);
  const state = buildPublicState(roomCode, room);
  const saved = persistAll();
  const notify = () => {
    io.to(roomCode).emit('state:update', state);
    if (room.spectators?.size) io.to(viewerChannel(roomCode)).emit('state:update', buildSpectatorState(roomCode, room));
  };
  if (saved) saved.then(notify);
  else notify();
}

function findPlayerRoom(socketId) {
  for (const [roomCode, room] of rooms.entries()) {
    for (const key of ['white', 'black']) {
      if (room.players[key]?.socketId === socketId) {
        return { roomCode, room, color: key };
      }
    }
  }
  return null;
}

// Uzun süre boş kalan odalar belleği doldurmasın.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if ((room.players.white?.connected || room.players.black?.connected)) continue;
    if (now - room.lastActivityAt > ROOM_IDLE_EXPIRY_MS) {
      removeRoom(code, room, 'Oda uzun süre boş kaldığı için kapatıldı.');
    }
  }
}, 10 * 60 * 1000).unref();

function getSocketAccount(socket) {
  return socket?.data?.sessionHash ? accounts.resolveHash(socket.data.sessionHash) : null;
}
function resolvedPlayerName(socket, name, fallback) {
  const account = getSocketAccount(socket);
  if (account) return account.username;
  const result = sanitizeName(name, fallback);
  if (accounts.isReserved(result) || ['Sistem', 'System', 'Admin'].includes(result)) {
    socket.emit('room:error', 'Bu isim kayıtlı bir kullanıcıya ayrılmış. Başka bir isim seç veya hesabına giriş yap.');
    return null;
  }
  return result;
}
function isPlayerReclaimable(player, token, accountId) {
  if (!player) return false;
  if (player.accountId) return !!accountId && player.accountId === accountId;
  return sameToken(player, token);
}

io.on('connection', (socket) => {
  const sessionToken = readCookie(socket.request?.headers?.cookie);
  socket.data.sessionHash = sessionToken && accounts.resolveToken(sessionToken) ? tokenHash(sessionToken) : null;
  socket.join(PUBLIC_LOBBY_CHANNEL);
  socket.emit('rooms:list', listOpenPublicRooms());
  socket.emit('matches:list', listSpectatablePublicMatches());
  socket.on('rooms:request', () => {
    socket.emit('rooms:list', listOpenPublicRooms());
    socket.emit('matches:list', listSpectatablePublicMatches());
  });
  socket.on('viewer:leave', () => {
    if (!allowSocketAction(socket, 'viewer', 8)) return;
    stopWatching(socket);
    socket.emit('viewer:left');
  });
  onProtected(socket, 'viewer:watch', (payload = {}) => {
    if (!allowSocketAction(socket, 'viewer', 8)) return;
    const rawCode = payload && typeof payload === 'object' ? payload.roomCode : null;
    if (typeof rawCode !== 'string' || !/^[A-Z0-9]{5}$/.test(rawCode.trim().toUpperCase())) {
      socket.emit('room:error', 'Geçersiz oda kodu.'); return;
    }
    const roomCode = rawCode.trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room || !room.allowSpectators || !room.hasStarted || !room.players.black) {
      socket.emit('room:error', 'Bu maç izlemeye açık değil veya henüz başlamadı.'); return;
    }
    if (findPlayerRoom(socket.id)) {
      socket.emit('room:error', 'İzlemek için önce oynadığın odadan ayrılmalısın.'); return;
    }
    if (socket.data.watchingRoom && socket.data.watchingRoom !== roomCode) stopWatching(socket);
    if (!room.spectators.has(socket.id) && room.spectators.size >= MAX_SPECTATORS_PER_ROOM) {
      socket.emit('room:error', 'Bu maçın izleyici kapasitesi doldu.'); return;
    }
    room.spectators.add(socket.id);
    socket.data.watchingRoom = roomCode;
    socket.join(viewerChannel(roomCode));
    socket.emit('viewer:joined', { roomCode });
    socket.emit('state:update', buildSpectatorState(roomCode, room));
    updateSpectatorCount(roomCode, room);
  });
  socket.on('history:request', (payload = {}) => {
    const now = Date.now();
    socket.data.historyRequests = (socket.data.historyRequests || []).filter(time => now - time < 60_000);
    if (socket.data.historyRequests.length >= 10) return;
    socket.data.historyRequests.push(now);
    sendHistory(socket, payload && typeof payload === 'object' ? payload.playerToken : null);
  });
  socket.data.roomCreates = [];
  onProtected(socket, 'room:create', (payload = {}) => {
    const { name, targetScore, playerToken, autoDice, visibility, allowSpectators } = payload && typeof payload === 'object' ? payload : {};
    if (socket.data.watchingRoom) { socket.emit('room:error', 'Önce izlediğin maçtan çıkmalısın.'); return; }
    const now = Date.now();
    socket.data.roomCreates = socket.data.roomCreates.filter(t => now - t < 60_000);
    if (socket.data.roomCreates.length >= 3 || rooms.size >= MAX_ROOMS) {
      socket.emit('room:error', 'Çok fazla oda oluşturuldu. Biraz sonra tekrar dene.');
      return;
    }
    socket.data.roomCreates.push(now);
    if (typeof playerToken !== 'string' || playerToken.length < 20 || playerToken.length > 100) {
      socket.emit('room:error', 'Güvenli oyuncu anahtarı bulunamadı. Sayfayı yenile.');
      return;
    }
    if (preventMultipleRooms(socket, playerToken)) return;
    const parsedScore = ['string', 'number'].includes(typeof targetScore) ? Number(targetScore) : 5;
    const score = [3, 5, 7, 11].includes(parsedScore) ? parsedScore : 5;
    let roomCode = randomRoomCode();
    while (rooms.has(roomCode)) roomCode = randomRoomCode();

    const playerName = resolvedPlayerName(socket, name, 'Oyuncu 1');
    if (!playerName) return;
    const room = createRoomModel(score, socket.id, playerName, playerToken, autoDice, visibility, getSocketAccount(socket)?.id || null, allowSpectators === true);

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color: 'white' });
    emitRoomState(roomCode);
    broadcastOpenPublicRooms();
  });

  onProtected(socket, 'room:join', (payload = {}) => {
    if (socket.data.watchingRoom) { socket.emit('room:error', 'Önce izlediğin maçtan çıkmalısın.'); return; }
    const now = Date.now();
    socket.data.roomJoins = (socket.data.roomJoins || []).filter(t => now - t < 60_000);
    if (socket.data.roomJoins.length >= 12) {
      socket.emit('room:error', 'Çok fazla katılma denemesi. Bir dakika sonra yeniden dene.');
      return;
    }
    socket.data.roomJoins.push(now);
    let { roomCode, name, playerToken, autoDice } = payload && typeof payload === 'object' ? payload : {};
    if (typeof playerToken !== 'string' || playerToken.length < 20 || playerToken.length > 100) {
      socket.emit('room:error', 'Güvenli oyuncu anahtarı bulunamadı. Sayfayı yenile.');
      return;
    }
    if (typeof roomCode !== 'string' || roomCode.length > 20) {
      socket.emit('room:error', 'Geçersiz oda kodu.');
      return;
    }
    roomCode = roomCode.toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('room:error', 'Oda bulunamadı.');
      return;
    }
    if (preventMultipleRooms(socket, playerToken, roomCode)) return;

    const accountId = getSocketAccount(socket)?.id || null;
    const reconnectBlack = isPlayerReclaimable(room.players.black, playerToken, accountId);
    const reconnectWhite = isPlayerReclaimable(room.players.white, playerToken, accountId);

    if (reconnectWhite) {
      displaceOldSocket(roomCode, room.players.white, socket.id);
      attachPlayer(room.players.white, socket.id, accountId ? getSocketAccount(socket).username : name, playerToken, autoDice, accountId || room.players.white.accountId || null);
      stopReconnectTimer(room, 'white');
      socket.join(roomCode);
      socket.emit('room:joined', { roomCode, color: 'white' });
      emitRoomState(roomCode);
      maybeStartTurnRoll(roomCode);
      broadcastOpenPublicRooms();
      return;
    }

    if (reconnectBlack) {
      displaceOldSocket(roomCode, room.players.black, socket.id);
      attachPlayer(room.players.black, socket.id, accountId ? getSocketAccount(socket).username : name, playerToken, autoDice, accountId || room.players.black.accountId || null);
      stopReconnectTimer(room, 'black');
      socket.join(roomCode);
      socket.emit('room:joined', { roomCode, color: 'black' });
      emitRoomState(roomCode);
      maybeStartTurnRoll(roomCode);
      return;
    }

    if (room.players.black) {
      socket.emit('room:error', 'Bu oda dolu.');
      return;
    }

    const playerName = resolvedPlayerName(socket, name, 'Oyuncu 2');
    if (!playerName) return;
    room.players.black = attachPlayer({}, socket.id, playerName, playerToken, autoDice, accountId);
    room.hasStarted = true;
    pushChatMessage(room, 'system', 'Sistem', `${room.players.black.name} odaya katıldı.`);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color: 'black' });
    emitRoomState(roomCode);
    maybeStartTurnRoll(roomCode, 900);
    broadcastOpenPublicRooms();
  });

  onProtected(socket, 'player:reconnect', (payload = {}) => {
    if (socket.data.watchingRoom) return;
    const { playerToken, autoDice } = payload && typeof payload === 'object' ? payload : {};
    const accountId = getSocketAccount(socket)?.id || null;
    const byToken = findPlayerRoomByToken(typeof playerToken === 'string' ? playerToken : null);
    const found = byToken && isPlayerReclaimable(byToken.room.players[byToken.color], playerToken, accountId)
      ? byToken : findPlayerRoomByAccountId(accountId);
    if (!found) {
      socket.emit('player:reconnect-missing');
      return;
    }
    const { roomCode, room, color } = found;
    if (preventMultipleRooms(socket, playerToken, roomCode)) return;
    displaceOldSocket(roomCode, room.players[color], socket.id);
    attachPlayer(room.players[color], socket.id, accountId ? getSocketAccount(socket).username : null, playerToken, autoDice, accountId || room.players[color].accountId || null);
    stopReconnectTimer(room, color);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color });
    emitRoomState(roomCode);
    maybeStartTurnRoll(roomCode);
    broadcastOpenPublicRooms();
  });

  onProtected(socket, 'settings:autoDice', (payload = {}) => {
    const { enabled } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    room.players[color].autoDice = enabled !== false;
    emitRoomState(roomCode);
    if (room.game.turn === color && !room.game.pendingState && !room.game.winner) {
      if (room.players[color].autoDice) maybeStartTurnRoll(roomCode, 350);
      else if (room.game.autoRollTimer && !room.game.diceRolling) {
        clearTimeout(room.game.autoRollTimer);
        room.game.autoRollTimer = null;
      }
    }
  });

  onProtected(socket, 'dice:roll', () => {
    if (!allowSocketAction(socket, 'dice')) return;
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;

    if (game.winner || game.animating) return;
    if (game.turn !== color) return;
    if (game.pendingState) return;
    if (!room.players.white || !room.players.black) return;
    if (room.players[color]?.autoDice || game.doubleOffer || game.diceRolling) return;
    if (!bothPlayersOnline(room)) return;

    scheduleAutoRoll(roomCode, 0);
  });

  onProtected(socket, 'move:play', (payload = {}) => {
    if (!allowSocketAction(socket, 'move', 12)) return;
    const { actionId, from, to } = payload && typeof payload === 'object' ? payload : {};
    const validId = typeof actionId === 'string' && actionId.length <= 256;
    const validFrom = (Number.isInteger(from) && from >= 0 && from < 24) || from === 'bar';
    const validTo = (Number.isInteger(to) && to >= 0 && to < 24) || to === 'off';
    if (!validId && !(validFrom && validTo)) return;
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;

    if (game.winner || game.animating || game.doubleOffer || !bothPlayersOnline(room)) return;
    if (game.turn !== color) return;
    if (!game.pendingState) return;

    const options = legalMoveOptions(game.pendingState, color, game.dice);
    const chosen = (validId && options.find((m) => m.id === actionId))
      || ((validFrom && validTo) && options.find((m) => m.from === from && m.to === to));
    if (!chosen) return;

    game.animating = true;
    const animation = { color, path: chosen.path, snapshot: cloneState(game.pendingState) };
    io.to(roomCode).emit('move:animate', animation);
    io.to(viewerChannel(roomCode)).emit('move:animate', animation);

    const totalDelay = Math.max(260, chosen.path.length * 280 + 120);
    game.moveTimer = setTimeout(() => {
      game.moveTimer = null;
      if (rooms.get(roomCode) !== room || room.game !== game) return;
      for (const step of chosen.path) {
        game.pendingState = applyMove(game.pendingState, color, step);
        game.dice = game.dice.filter((_, idx) => idx !== step.dieIndex);
      }
      game.movedThisTurn = true;
      game.animating = false;
      emitRoomState(roomCode);
    }, totalDelay);
  });

  onProtected(socket, 'turn:reset', () => {
    if (!allowSocketAction(socket, 'turn')) return;
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;

    if (game.winner || game.animating || game.doubleOffer || !bothPlayersOnline(room)) return;
    if (game.turn !== color) return;
    if (!game.pendingState) return;
    if (!game.movedThisTurn) return;

    game.pendingState = cloneState(game.turnStartState || game.state);
    game.dice = [...(game.turnStartDice || game.dice)];
    game.movedThisTurn = false;

    emitRoomState(roomCode);
  });

  onProtected(socket, 'turn:confirm', () => {
    if (!allowSocketAction(socket, 'turn')) return;
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;

    if (game.winner || game.animating || game.doubleOffer || !bothPlayersOnline(room)) return;
    if (game.turn !== color) return;
    if (!game.pendingState) return;

    const noMovesAvailable = !hasAnyLegalMove(game.pendingState, game.turn, game.dice);
    if (!noMovesAvailable && game.dice.length > 0) return;
    if (!game.movedThisTurn && game.dice.length === 0 && game.turnStartDice?.length) return;

    game.state = cloneState(game.pendingState);
    game.pendingState = null;
    game.dice = [];
    game.rolledPair = null;
    game.movedThisTurn = false;

    const won = isGameWon(game.state);
    if (won) {
      awardRoundTo(roomCode, room, won);
    } else {
      game.turn = opponent(game.turn);
    }

    game.turnStartState = null;
    game.turnStartDice = [];

    emitRoomState(roomCode);
    if (!game.winner) maybeStartTurnRoll(roomCode, 900);
  });



  onProtected(socket, 'double:offer', () => {
    if (!allowSocketAction(socket, 'double')) return;
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;

    if (game.turn !== color) return;
    if (!canOfferDouble(room)) return;

    if (game.autoRollTimer) {
      clearTimeout(game.autoRollTimer);
      game.autoRollTimer = null;
    }
    game.doubleOffer = { offeredBy: color, multiplier: 2, createdAt: Date.now() };
    const offererName = room.players[color]?.name || 'Oyuncu';
    pushChatMessage(room, 'system', 'Sistem', `${offererName} 2x teklifi gönderdi.`);
    emitRoomState(roomCode);
  });

  onProtected(socket, 'double:respond', (payload = {}) => {
    if (!allowSocketAction(socket, 'double')) return;
    const { accept } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;
    const offer = game.doubleOffer;

    if (!offer || !bothPlayersOnline(room)) return;
    if (offer.offeredBy === color || typeof accept !== 'boolean') return;

    const responderName = room.players[color]?.name || 'Oyuncu';
    const offererName = room.players[offer.offeredBy]?.name || 'Oyuncu';

    if (accept) {
      game.roundMultiplier = offer.multiplier || 2;
      game.doubleOffer = null;
      pushChatMessage(room, 'system', 'Sistem', `${responderName} 2x teklifini kabul etti. Bu el ${game.roundMultiplier}x oynanacak.`);
      emitRoomState(roomCode);
      maybeStartTurnRoll(roomCode, 1000);
      return;
    }

    game.doubleOffer = null;
    game.pendingState = null;
    game.dice = [];
    game.rolledPair = null;
    game.movedThisTurn = false;
    game.turnStartState = null;
    game.turnStartDice = [];

    awardRoundTo(roomCode, room, offer.offeredBy, {
      forcedPoints: 2,
      reasonText: `${offererName} 2x teklifini gönderdi, ${responderName} kabul etmedi. ${offererName} bu el için 2 puan aldı.`
    });
    emitRoomState(roomCode);
    if (!game.winner) maybeStartTurnRoll(roomCode);
  });

  onProtected(socket, 'chat:send', (payload = {}) => {
    const { text } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const player = room.players[color];
    const now = Date.now();
    socket.data.chatTimes = (socket.data.chatTimes || []).filter(t => now - t < 10_000);
    if (socket.data.chatTimes.length >= 8) return;
    socket.data.chatTimes.push(now);
    if (typeof text !== 'string' || text.length > 500) return;
    const msg = pushChatMessage(room, color, player?.name || 'Oyuncu', text);
    if (!msg) return;
    const saved = persistAll();
    if (saved) saved.then(() => io.to(roomCode).emit('chat:message', msg));
    else io.to(roomCode).emit('chat:message', msg);
  });

  onProtected(socket, 'match:rematch', () => {
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    if (!bothPlayersOnline(room) || !room.game.winner) return;
    room.game.rematchVotes[color] = true;
    if (room.game.rematchVotes.white && room.game.rematchVotes.black) {
      resetRoomForRematch(room);
      pushChatMessage(room, 'system', 'Sistem', 'İki oyuncu da rövanşı kabul etti. Yeni maç başladı.');
      emitRoomState(roomCode);
      maybeStartTurnRoll(roomCode);
    } else {
      emitRoomState(roomCode);
    }
  });

  onProtected(socket, 'room:leave', () => {
    // Çalınmış/eski oyuncu tokenı ile başka aktif oturumun odası kapatılamaz.
    // Önce player:reconnect ile o oturuma bağlanılması gerekir.
    const found = findPlayerRoom(socket.id);
    if (!found) {
      socket.emit('room:error', 'Odadan çıkmak için önce oyuncu oturumunu yeniden bağla.');
      return;
    }
    const { roomCode, room, color } = found;
    const name = room.players[color]?.name || 'Oyuncu';
    removeRoom(roomCode, room, `${name} odadan ayrıldı. Oda kapatıldı; yeni bir oda açabilirsiniz.`);
  });

  socket.on('disconnect', () => {
    stopWatching(socket);
    const found = findPlayerRoom(socket.id);
    if (!found) return;

    const { roomCode, room, color } = found;
    if (room.players[color]) {
      room.players[color].connected = false;
      room.players[color].disconnectedAt = Date.now();
    }
    if (room.game.doubleOffer) {
      room.game.doubleOffer = null;
      pushChatMessage(room, 'system', 'Sistem', 'Bağlantı kesildiği için bekleyen 2x teklifi iptal edildi.');
    }
    // Yarım kalmış animasyon yeniden bağlandıktan sonra tekrar uygulanabilir.
    // Sunucu, oyuncu yokken taş, zar veya sıra ilerletmez.
    clearGameTimers(room.game);
    startReconnectTimer(roomCode, room, color);
    emitRoomState(roomCode);
    broadcastOpenPublicRooms();
  });
});

function getLocalNetworkUrls(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
      if (net.family === familyV4Value && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

async function startServer() {
  if (databaseConfigured) {
    const { PostgresStore } = require('./postgres-store');
    databaseStore = new PostgresStore({
      connectionString: process.env.DATABASE_URL,
      onStatus: healthy => {
        const wasReady = databaseReady;
        databaseReady = healthy;
        if (!healthy && wasReady) logEvent('warn', 'database_temporarily_unavailable');
        if (healthy && !wasReady) {
          logEvent('info', 'database_recovered');
          for (const roomCode of rooms.keys()) maybeStartTurnRoll(roomCode);
        }
      },
      onError: (event, error) => logEvent('error', event, { code: error.code, message: error.message })
    });
    let saved = await databaseStore.initialize();
    if (!saved) {
      // v13 dosyasından yalnızca PostgreSQL tamamen boşsa ilk kez aktar.
      const previousFile = loadSnapshot();
      if (previousFile) {
        await databaseStore.save(previousFile);
        saved = previousFile;
        logEvent('info', 'legacy_snapshot_imported');
      }
    }
    restoreSavedRooms(saved);
    logEvent('info', 'postgres_connected');
    const heartbeat = setInterval(() => {
      if (!databaseStore.healthy) databaseStore.ping();
    }, 10_000);
    heartbeat.unref?.();
  } else if (process.env.NODE_ENV === 'production' && process.env.TAVLA_ALLOW_FILE_STORAGE !== 'true') {
    throw new Error('Üretim ortamında DATABASE_URL gerekli. Kayıtların geçici diskte kaybolması engellendi.');
  } else if (!databaseConfigured) {
    logEvent('warn', 'file_storage_mode', { message: 'Yerel geliştirme modu: PostgreSQL kullanılmıyor.' });
  }
  server.listen(PORT, '0.0.0.0', () => {
    logEvent('info', 'server_listening', { message: `port=${PORT}` });
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Tavla sunucusu yerelde: http://localhost:${PORT}`);
      getLocalNetworkUrls(PORT).forEach(url => console.log(`- ${url}`));
    }
  });
}

if (typeof server.on === 'function') server.on('error', error =>
  logEvent('error', 'http_server_error', { code: error.code, message: error.message }));
if (typeof process.on === 'function') {
  process.on('unhandledRejection', error => {
    logEvent('error', 'unhandled_rejection', { message: error?.message || String(error) });
    process.exitCode = 1;
  });
  process.on('uncaughtException', error => {
    logEvent('error', 'uncaught_exception', { message: error?.message || String(error) });
    process.exit(1);
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    logEvent('info', 'graceful_shutdown', { message: signal });
    // Önce yeni komutları durdur, kalan yazmaları PostgreSQL'e gönder.
    databaseReady = false;
    const stopTimeout = setTimeout(() => process.exit(1), 12_000);
    stopTimeout.unref?.();
    try {
      for (const [, room] of rooms) clearGameTimers(room.game);
      io.close();
      server.close();
      if (databaseStore) {
        await databaseStore.flush();
        await databaseStore.close();
      }
      clearTimeout(stopTimeout);
      process.exit(0);
    } catch (error) {
      logEvent('error', 'shutdown_failed', { message: error.message });
      process.exit(1);
    }
  });
}

// Dosya modunda test kancaları senkron; DB modunda HTTP yalnızca kayıt yüklenince açılır.
if (databaseConfigured) {
  startServer().catch(error => {
    logEvent('error', 'startup_failed', { code: error.code, message: error.message });
    if (typeof process.exit === 'function') process.exit(1);
    else throw error;
  });
} else if (process.env.NODE_ENV === 'production' && process.env.TAVLA_ALLOW_FILE_STORAGE !== 'true') {
  startServer().catch(error => {
    logEvent('error', 'startup_failed', { message: error.message });
    process.exit(1);
  });
} else {
  // Bu dal sadece dosya kullanan yerel geliştirmede çalışır.
  startServer();
}
