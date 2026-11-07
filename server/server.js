const path = require('path');
const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { loadSnapshot, saveSnapshot } = require('./storage');
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
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const ROOM_IDLE_EXPIRY_MS = 60 * 60 * 1000; // 1 saat boyunca iki oyuncu da yoksa oda silinir.
const PUBLIC_LOBBY_CHANNEL = 'public-lobby';
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
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'client')));

const rooms = new Map();
const matchHistory = [];
let nextChatId = 1;
let nextSummaryId = 1;

// Sunucu tek otoritedir. Sadece doğrulanmış hamleler ve sunucu zarları kaydedilir.
// Oyuncu tokenları ve oda anlık görüntüleri client klasörüne ASLA yazılmaz.
function persistAll() {
  saveSnapshot({
    version: 1,
    nextChatId,
    nextSummaryId,
    history: matchHistory,
    rooms: [...rooms.entries()].map(([roomCode, room]) => ({
      roomCode,
      players: Object.fromEntries(['white', 'black'].map(color => {
        const player = room.players[color];
        return [color, player ? {
          name: player.name, playerToken: player.playerToken, autoDice: player.autoDice,
          disconnectedAt: player.disconnectedAt || null
        } : null];
      })),
      chat: room.chat,
      visibility: room.visibility,
      hasStarted: room.hasStarted,
      matchId: room.matchId,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      game: { ...room.game, autoRollTimer: null, moveTimer: null, animating: false, diceRolling: false }
    }))
  });
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

function sendHistory(socket, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 100) {
    socket.emit('history:list', []);
    return;
  }
  // Bunu ancak tahmin edilmesi zor oyuncu anahtarına sahip olan görebilir.
  socket.emit('history:list', matchHistory
    .filter(match => match.playerTokens.includes(token))
    .slice(-15).reverse()
    .map(({ playerTokens, ...publicRecord }) => publicRecord));
}

function removeRoom(roomCode, room, reason) {
  if (rooms.get(roomCode) !== room) return;
  clearGameTimers(room.game);
  for (const timer of Object.values(room.reconnectTimers || {})) clearTimeout(timer);
  archiveMatch(room, room.game.winner ? 'finished' : 'interrupted');
  rooms.delete(roomCode);
  persistAll();
  broadcastOpenPublicRooms();
  io.to(roomCode).emit('room:closed', { reason });
  for (const player of [room.players.white, room.players.black]) {
    const memberSocket = player?.socketId && io.sockets.sockets.get(player.socketId);
    if (memberSocket) memberSocket.leave(roomCode);
  }
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

function restoreSavedRooms() {
  const saved = loadSnapshot();
  if (!saved) return;
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
        playerToken: member.playerToken,
        autoDice: member.autoDice !== false,
        connected: false, socketId: null,
        disconnectedAt: member.disconnectedAt || Date.now()
      } : null];
    }));
    const room = {
      players,
      chat: Array.isArray(data.chat) ? data.chat.slice(-120) : [],
      visibility: data.visibility === 'public' ? 'public' : 'private',
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
restoreSavedRooms();

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}


function sameToken(player, token) {
  return !!player && !!token && player.playerToken === token;
}

function attachPlayer(player, socketId, name, token, autoDice) {
  player.socketId = socketId;
  player.connected = true;
  player.disconnectedAt = null;
  if (name) player.name = sanitizeName(name, player.name || 'Oyuncu');
  if (token) player.playerToken = token;
  if (typeof autoDice === 'boolean') player.autoDice = autoDice;
  if (typeof player.autoDice !== 'boolean') player.autoDice = true;
  return player;
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
  return !!(game && !game.winner && !game.animating && !game.pendingState &&
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
  if ((active && active.roomCode !== requestedCode) || (byToken && byToken.roomCode !== requestedCode)) {
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

function createRoomModel(score, creatorSocketId, creatorName, creatorToken, creatorAutoDice = true, visibility = 'private') {
  return {
    players: {
      white: { socketId: creatorSocketId, name: sanitizeName(creatorName, 'Oyuncu 1'), connected: true, playerToken: creatorToken || null, autoDice: creatorAutoDice !== false },
      black: null
    },
    chat: [],
    visibility: visibility === 'public' ? 'public' : 'private',
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

function broadcastOpenPublicRooms() {
  io.to(PUBLIC_LOBBY_CHANNEL).emit('rooms:list', listOpenPublicRooms());
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
  if (!bothPlayersOnline(room)) return false;
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

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  refreshRoomActivity(room);
  persistAll();
  io.to(roomCode).emit('state:update', buildPublicState(roomCode, room));
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

io.on('connection', (socket) => {
  socket.join(PUBLIC_LOBBY_CHANNEL);
  socket.emit('rooms:list', listOpenPublicRooms());
  socket.on('rooms:request', () => socket.emit('rooms:list', listOpenPublicRooms()));
  socket.on('history:request', (payload = {}) => {
    const now = Date.now();
    socket.data.historyRequests = (socket.data.historyRequests || []).filter(time => now - time < 60_000);
    if (socket.data.historyRequests.length >= 10) return;
    socket.data.historyRequests.push(now);
    sendHistory(socket, payload && typeof payload === 'object' ? payload.playerToken : null);
  });
  socket.data.roomCreates = [];
  socket.on('room:create', (payload = {}) => {
    const { name, targetScore, playerToken, autoDice, visibility } = payload && typeof payload === 'object' ? payload : {};
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

    const room = createRoomModel(score, socket.id, name, playerToken, autoDice, visibility);

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color: 'white' });
    emitRoomState(roomCode);
    broadcastOpenPublicRooms();
  });

  socket.on('room:join', (payload = {}) => {
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

    const reconnectBlack = sameToken(room.players.black, playerToken);
    const reconnectWhite = sameToken(room.players.white, playerToken);

    if (reconnectWhite) {
      displaceOldSocket(roomCode, room.players.white, socket.id);
      attachPlayer(room.players.white, socket.id, name, playerToken, autoDice);
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
      attachPlayer(room.players.black, socket.id, name, playerToken, autoDice);
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

    room.players.black = attachPlayer({}, socket.id, name || 'Oyuncu 2', playerToken, autoDice);
    room.hasStarted = true;
    pushChatMessage(room, 'system', 'Sistem', `${room.players.black.name} odaya katıldı.`);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color: 'black' });
    emitRoomState(roomCode);
    maybeStartTurnRoll(roomCode, 900);
    broadcastOpenPublicRooms();
  });

  socket.on('player:reconnect', (payload = {}) => {
    const { playerToken, autoDice } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoomByToken(typeof playerToken === 'string' ? playerToken : null);
    if (!found) {
      socket.emit('player:reconnect-missing');
      return;
    }
    const { roomCode, room, color } = found;
    if (preventMultipleRooms(socket, playerToken, roomCode)) return;
    displaceOldSocket(roomCode, room.players[color], socket.id);
    attachPlayer(room.players[color], socket.id, null, playerToken, autoDice);
    stopReconnectTimer(room, color);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color });
    emitRoomState(roomCode);
    maybeStartTurnRoll(roomCode);
    broadcastOpenPublicRooms();
  });

  socket.on('settings:autoDice', (payload = {}) => {
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

  socket.on('dice:roll', () => {
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

  socket.on('move:play', (payload = {}) => {
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
    io.to(roomCode).emit('move:animate', {
      color,
      path: chosen.path,
      snapshot: cloneState(game.pendingState)
    });

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

  socket.on('turn:reset', () => {
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

  socket.on('turn:confirm', () => {
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



  socket.on('double:offer', () => {
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

  socket.on('double:respond', (payload = {}) => {
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

  socket.on('chat:send', (payload = {}) => {
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
    persistAll();
    io.to(roomCode).emit('chat:message', msg);
  });

  socket.on('match:rematch', () => {
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

  socket.on('room:leave', () => {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tavla sunucusu yerelde: http://localhost:${PORT}`);
  const urls = getLocalNetworkUrls(PORT);
  if (urls.length) {
    console.log('Ayni Wi-Fi agindaki telefon/tablet icin kullanabilecegin adresler:');
    urls.forEach((url) => console.log(`- ${url}`));
  } else {
    console.log('Yerel IP adresi bulunamadi. Gerekirse ipconfig ile IPv4 adresini kontrol et.');
  }
});
