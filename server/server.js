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
const MAX_ROOMS = 200; // Hobi sunucusunu sınırsız oda oluşturmaktan korur.

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


function performAutoRoll(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const game = room.game;
  if (game.winner || game.animating || game.pendingState) return;
  if (!room.players.white || !room.players.black) return;

  const rolled = rollDice();
  game.rolledPair = rolled.pair;
  game.dice = rolled.dice;
  game.pendingState = cloneState(game.state);
  game.turnStartState = cloneState(game.state);
  game.turnStartDice = [...rolled.dice];
  game.movedThisTurn = false;
  game.roundSummary = null;
  game.matchSummary = null;
  game.autoRollTimer = null;

  emitRoomState(roomCode);
}


function maybeStartTurnRoll(roomCode, delay = 900) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const game = room.game;
  if (game.winner || game.animating || game.pendingState) return;
  if (!room.players.white || !room.players.black) return;
  const currentPlayer = room.players[game.turn];
  if (currentPlayer?.autoDice) scheduleAutoRoll(roomCode, delay);
}

function scheduleAutoRoll(roomCode, delay = 1200) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const game = room.game;
  if (game.autoRollTimer) clearTimeout(game.autoRollTimer);
  if (game.winner || game.animating || game.pendingState) return;
  if (!room.players.white || !room.players.black) return;

  io.to(roomCode).emit('dice:rolling', { color: game.turn, duration: delay });
  game.autoRollTimer = setTimeout(() => performAutoRoll(roomCode), delay);
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

function createRoomModel(score, creatorSocketId, creatorName, creatorToken, creatorAutoDice = true) {
  return {
    players: {
      white: { socketId: creatorSocketId, name: sanitizeName(creatorName, 'Oyuncu 1'), connected: true, playerToken: creatorToken || null, autoDice: creatorAutoDice !== false },
      black: null
    },
    chat: [],
    lastActivityAt: Date.now(),
    game: createMatch(score)
  };
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
  room.game = createMatch(room.game.targetScore);
}

function canOfferDouble(room) {
  const game = room?.game;
  if (!room || !game) return false;
  if (!room.players.white || !room.players.black) return false;
  if (game.winner || game.animating || game.pendingState) return false;
  if (game.doubleOffer) return false;
  return arePlayersSeparated(game.state);
}

function awardRoundTo(roomCode, room, winner, { multiplierOverride = null, reasonText = null, forcedPoints = null } = {}) {
  const game = room.game;
  const winnerName = winner === 'white' ? (room.players.white?.name || 'Beyaz') : (room.players.black?.name || 'Siyah');
  const loser = winner === 'white' ? 'black' : 'white';
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

  if (game.scores[winner] >= game.targetScore) {
    game.winner = winner;
    game.matchSummary = {
      id: nextSummaryId++,
      text: `${winnerName} maçı kazandı! Rövanş ister misiniz?`
    };
  }

  game.state = createInitialState();
  game.turn = loser;
}

function buildPublicState(roomCode, room) {
  const game = room.game;
  const activeState = game.pendingState || game.state;
  const moveOptions = game.pendingState ? legalMoveOptions(game.pendingState, game.turn, game.dice) : [];
  const noMovesAvailable = game.pendingState ? !hasAnyLegalMove(game.pendingState, game.turn, game.dice) : false;
  const hasRemainingMoves = moveOptions.length > 0;

  return {
    roomCode,
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
      waitingForRoll: !game.pendingState,
      noMovesAvailable,
      movedThisTurn: game.movedThisTurn,
      roundSummary: game.roundSummary || null,
      matchSummary: game.matchSummary || null,
      animating: !!game.animating,
      roundMultiplier: game.roundMultiplier || 1,
      noContactPhase: arePlayersSeparated(activeState),
      canOfferDouble: canOfferDouble(room),
      doubleOffer: game.doubleOffer || null
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
    if (now - room.lastActivityAt > ROOM_IDLE_EXPIRY_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

io.on('connection', (socket) => {
  socket.data.roomCreates = [];
  socket.on('room:create', (payload = {}) => {
    const { name, targetScore, playerToken, autoDice } = payload && typeof payload === 'object' ? payload : {};
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
    const score = Math.max(1, Math.min(15, Number(targetScore) || 5));
    let roomCode = randomRoomCode();
    while (rooms.has(roomCode)) roomCode = randomRoomCode();

    const room = createRoomModel(score, socket.id, name, playerToken, autoDice);

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color: 'white' });
    emitRoomState(roomCode);
  });

  socket.on('room:join', (payload = {}) => {
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

    const reconnectBlack = sameToken(room.players.black, playerToken);
    const reconnectWhite = sameToken(room.players.white, playerToken);

    if (reconnectWhite) {
      attachPlayer(room.players.white, socket.id, name, playerToken, autoDice);
      socket.join(roomCode);
      socket.emit('room:joined', { roomCode, color: 'white' });
      emitRoomState(roomCode);
      return;
    }

    if (reconnectBlack) {
      attachPlayer(room.players.black, socket.id, name, playerToken, autoDice);
      socket.join(roomCode);
      socket.emit('room:joined', { roomCode, color: 'black' });
      emitRoomState(roomCode);
      return;
    }

    if (room.players.black && room.players.black.socketId !== socket.id) {
      socket.emit('room:error', 'Bu oda dolu.');
      return;
    }

    room.players.black = attachPlayer(room.players.black || {}, socket.id, name || 'Oyuncu 2', playerToken, autoDice);
    pushChatMessage(room, 'system', 'Sistem', `${room.players.black.name} odaya katıldı.`);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color: 'black' });
    emitRoomState(roomCode);
    maybeStartTurnRoll(roomCode, 900);
  });

  socket.on('player:reconnect', (payload = {}) => {
    const { playerToken, autoDice } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoomByToken(typeof playerToken === 'string' ? playerToken : null);
    if (!found) {
      socket.emit('player:reconnect-missing');
      return;
    }
    const { roomCode, room, color } = found;
    attachPlayer(room.players[color], socket.id, null, playerToken, autoDice);
    socket.join(roomCode);
    socket.emit('room:joined', { roomCode, color });
    emitRoomState(roomCode);
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
      else if (room.game.autoRollTimer) {
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
    if (room.players[color]?.autoDice) return;

    scheduleAutoRoll(roomCode, 250);
  });

  socket.on('move:play', (payload = {}) => {
    const { actionId, from, to } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const game = room.game;

    if (game.winner || game.animating) return;
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
    setTimeout(() => {
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

    if (game.winner || game.animating) return;
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

    if (game.winner || game.animating) return;
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

    if (!offer) return;
    if (offer.offeredBy === color) return;

    const responderName = room.players[color]?.name || 'Oyuncu';
    const offererName = room.players[offer.offeredBy]?.name || 'Oyuncu';

    if (accept) {
      game.roundMultiplier = offer.multiplier || 2;
      game.doubleOffer = null;
      pushChatMessage(room, 'system', 'Sistem', `${responderName} 2x teklifini kabul etti. Bu el ${game.roundMultiplier}x oynanacak.`);
      emitRoomState(roomCode);
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
  });

  socket.on('chat:send', (payload = {}) => {
    const { text } = payload && typeof payload === 'object' ? payload : {};
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room, color } = found;
    const player = room.players[color];
    const msg = pushChatMessage(room, color, player?.name || 'Oyuncu', text);
    if (!msg) return;
    io.to(roomCode).emit('chat:message', msg);
  });

  socket.on('match:rematch', () => {
    const found = findPlayerRoom(socket.id);
    if (!found) return;
    const { roomCode, room } = found;
    if (!room.players.white || !room.players.black) return;
    resetRoomForRematch(room);
    pushChatMessage(room, 'system', 'Sistem', 'Rövanş başladı. Skorlar sıfırlandı.');
    emitRoomState(roomCode);
    maybeStartTurnRoll(roomCode, 900);
  });

  socket.on('disconnect', () => {
    const found = findPlayerRoom(socket.id);
    if (!found) return;

    const { roomCode, room, color } = found;
    if (room.players[color]) room.players[color].connected = false;
    if (room.game.autoRollTimer) {
      clearTimeout(room.game.autoRollTimer);
      room.game.autoRollTimer = null;
    }
    emitRoomState(roomCode);
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
