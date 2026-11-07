const path = require('path');
const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
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

function clearGameTimers(game) {
  if (game.autoRollTimer) clearTimeout(game.autoRollTimer);
  if (game.moveTimer) clearTimeout(game.moveTimer);
  game.autoRollTimer = null;
  game.moveTimer = null;
  game.diceRolling = false;
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
let nextChatId = 1;
let nextSummaryId = 1;

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

function publicPlayer(player) {
  if (!player) return null;
  // playerToken ve socketId asla diğer oyunculara gönderilmemeli.
  return { name: player.name, connected: player.connected, autoDice: player.autoDice };
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
      clearGameTimers(room.game);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

io.on('connection', (socket) => {
  socket.join(PUBLIC_LOBBY_CHANNEL);
  socket.emit('rooms:list', listOpenPublicRooms());
  socket.on('rooms:request', () => socket.emit('rooms:list', listOpenPublicRooms()));
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
    const parsedScore = Number(targetScore);
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
    roomCode = String(roomCode || '').toUpperCase().trim();
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
    const { actionId, from, to } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;

    if (game.winner || game.animating || game.doubleOffer || !bothPlayersOnline(room)) return;
    if (game.turn !== color) return;
    if (!game.pendingState) return;

    const options = legalMoveOptions(game.pendingState, color, game.dice);
    const chosen = options.find((m) => m.id === actionId)
      || options.find((m) => String(m.from) === String(from) && String(m.to) === String(to));
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
    const msg = pushChatMessage(room, color, player?.name || 'Oyuncu', text);
    if (!msg) return;
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

  socket.on('room:leave', (payload = {}) => {
    const playerToken = typeof payload?.playerToken === 'string' ? payload.playerToken : null;
    const found = findPlayerRoom(socket.id) || findPlayerRoomByToken(playerToken);
    if (!found) {
      socket.emit('room:closed', { reason: 'Odadan ayrıldın.' });
      return;
    }
    const { roomCode, room, color } = found;
    const name = room.players[color]?.name || 'Oyuncu';
    clearGameTimers(room.game);
    // Yarım kalmış maçın sahipsiz bir oyuncuyla devam etmesini önle.
    rooms.delete(roomCode);
    broadcastOpenPublicRooms();
    io.to(roomCode).emit('room:closed', {
      reason: `${name} odadan ayrıldı. Oda kapatıldı; yeni bir oda açabilirsiniz.`
    });
    for (const player of [room.players.white, room.players.black]) {
      const memberSocket = player?.socketId && io.sockets.sockets.get(player.socketId);
      if (memberSocket) memberSocket.leave(roomCode);
    }
  });

  socket.on('disconnect', () => {
    const found = findPlayerRoom(socket.id);
    if (!found) return;

    const { roomCode, room, color } = found;
    if (room.players[color]) room.players[color].connected = false;
    if (room.game.doubleOffer) {
      room.game.doubleOffer = null;
      pushChatMessage(room, 'system', 'Sistem', 'Bağlantı kesildiği için bekleyen 2x teklifi iptal edildi.');
    }
    // Oyuncu çevrimdışıyken zarlar veya teklifler kendiliğinden ilerlemez.
    if (room.game.autoRollTimer) {
      clearTimeout(room.game.autoRollTimer);
      room.game.autoRollTimer = null;
    }
    room.game.diceRolling = false;
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
