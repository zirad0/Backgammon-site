const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gameRules = require('../server/game');

function harness() {
  const sockets = new Map();
  const callbacks = new Map();
  const timers = new Map();
  let currentTime = 0;
  let nextTimerId = 1;
  let io;

  class FakeSocket {
    constructor(id) {
      this.id = id;
      this.handlers = new Map();
      this.events = [];
      this.rooms = new Set();
      this.data = {};
      sockets.set(id, this);
      callbacks.get('connection')(this);
    }
    on(name, fn) { this.handlers.set(name, fn); }
    emit(name, data) { this.events.push({ name, data: data == null ? data : structuredClone(data) }); }
    trigger(name, data) { const fn = this.handlers.get(name); assert.ok(fn, `handler exists: ${name}`); fn(data); }
    join(room) { this.rooms.add(room); }
    leave(room) { this.rooms.delete(room); }
    last(name) { return [...this.events].reverse().find(e => e.name === name)?.data; }
  }
  class FakeIO {
    constructor() { this.sockets = { sockets }; io = this; }
    on(name, fn) { callbacks.set(name, fn); }
    to(room) { return { emit: (name, data) => {
      for (const sock of sockets.values()) {
        if (sock.rooms.has(room)) sock.emit(name, data);
      }
    } }; }
  }
  const fakeExpress = () => ({ get() {}, use() {}, disable() {} });
  fakeExpress.static = () => (_req, _res) => {};
  const fakeHttp = { createServer: () => ({ listen: (_port, _host, callback) => callback() }) };
  const stubTimeout = (callback, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { at: currentTime + delay, callback });
    return id;
  };
  const advance = (ms) => {
    const until = currentTime + ms;
    for (let i = 0; i < 1000; i++) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      currentTime = due[1].at;
      due[1].callback();
    }
    currentTime = until;
  };
  const nativeRequire = require;
  const context = {
    require: (name) => name === 'express' ? fakeExpress
      : name === 'http' ? fakeHttp
      : name === 'socket.io' ? { Server: FakeIO }
      : name === './game' ? gameRules
      : nativeRequire(name),
    __dirname: path.join(__dirname, '..', 'server'),
    console: { log() {} }, process: { env: {} },
    setTimeout: stubTimeout, clearTimeout: id => timers.delete(id),
    setInterval: () => ({ unref() {} })
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8') +
    '\n globalThis.__test = { rooms, awardRoundTo, maybeStartTurnRoll };', context);
  return { createSocket: id => new FakeSocket(id), advance, rooms: context.__test.rooms, io, helpers: context.__test };
}
function setupPair({ autoDice = false, score = 5 } = {}) {
  const h = harness();
  const a = h.createSocket('a');
  const b = h.createSocket('b');
  a.trigger('room:create', { name: 'A', targetScore: score, playerToken: 'a'.repeat(36), autoDice });
  const roomCode = a.last('room:joined').roomCode;
  b.trigger('room:join', { roomCode, name: 'B', playerToken: 'b'.repeat(36), autoDice });
  const room = h.rooms.get(roomCode);
  return { ...h, a, b, room, roomCode };
}
function separatedState() {
  const state = gameRules.createInitialState();
  state.points.fill(0);
  state.points[3] = 15;
  state.points[20] = -15;
  return state;
}

test('oda oluşturma, katılma, özel token saklama ve ikinci oda engeli', () => {
  const { a, b, room, roomCode } = setupPair();
  assert.equal(room.players.white.name, 'A');
  assert.equal(room.players.black.name, 'B');
  assert.equal(a.last('state:update').roomCode, roomCode);
  assert.equal(JSON.stringify(a.last('state:update')).includes('playerToken'), false);
  a.trigger('room:create', { name: 'Yeni', playerToken: 'a'.repeat(36) });
  assert.match(a.last('room:error'), /Önce açık/);
});

test('2x teklifi yalnızca uygun aşamada yapılır; cevap verene kadar zar atılmaz', () => {
  const { a, b, room, advance } = setupPair({ autoDice: true });
  a.trigger('double:offer');
  assert.equal(room.game.doubleOffer, null);
  // İlk otomatik zar geri sayımından önce taşlar birbirinden ayrıldı.
  room.game.state = separatedState();
  a.trigger('double:offer');
  assert.equal(room.game.doubleOffer.offeredBy, 'white');
  advance(10_000);
  assert.equal(room.game.pendingState, null);
  b.trigger('dice:roll');
  assert.equal(room.game.pendingState, null);
  a.trigger('double:respond', { accept: true });
  assert.ok(room.game.doubleOffer);
  b.trigger('double:respond', { accept: true });
  assert.equal(room.game.doubleOffer, null);
  assert.equal(room.game.roundMultiplier, 2);
  a.trigger('double:offer');
  assert.equal(room.game.doubleOffer, null);
  advance(2000);
  assert.ok(room.game.pendingState);
  assert.ok(room.game.dice.length >= 2);
});

test('2x reddi iki puan verir, yeni elde kazananı başlatır', () => {
  const { a, b, room, roomCode } = setupPair();
  room.game.state = separatedState();
  a.trigger('double:offer');
  b.trigger('double:respond', { accept: false });
  assert.equal(room.game.scores.white, 2);
  assert.equal(room.game.scores.black, 0);
  assert.equal(room.game.turn, 'white');
  assert.equal(room.game.roundMultiplier, 1);
  assert.deepEqual(Array.from(room.game.state.points), gameRules.createInitialState().points);
  assert.match(a.last('state:update').game.roundSummary.text, /2 puan/);
  assert.equal(roomCode.length, 5);
});

test('normal oyun kazanılınca yeni el kazananla başlar; mars iki puandır', () => {
  const { a, room, advance } = setupPair({ score: 3 });
  assert.equal(gameRules.getRoundPoints(separatedState(), 'white'), 2);
  const almostWon = separatedState();
  almostWon.points[3] = 0;
  almostWon.points[0] = 1;
  almostWon.off.white = 14;
  room.game.state = structuredClone(almostWon);
  room.game.pendingState = structuredClone(almostWon);
  room.game.turn = 'white';
  room.game.dice = [1];
  room.game.turnStartDice = [1];
  room.game.turnStartState = structuredClone(almostWon);
  const options = gameRules.legalMoveOptions(room.game.pendingState, 'white', [1]);
  const winningMove = options.find(option => option.to === 'off');
  assert.ok(winningMove);
  a.trigger('move:play', { actionId: winningMove.id });
  advance(1000);
  assert.equal(room.game.pendingState.off.white, 15);
  a.trigger('turn:confirm');
  assert.equal(room.game.turn, 'white');
  assert.equal(room.game.scores.white, 2);
  assert.equal(room.game.winner, null);
  assert.equal(room.game.roundSummary.id > 0, true);
});

test('rövanş yalnızca maç bitince ve iki oyuncunun onayıyla başlar', () => {
  const { a, b, room } = setupPair();
  a.trigger('match:rematch');
  assert.equal(room.game.rematchVotes.white, false);
  room.game.winner = 'white';
  room.game.scores.white = 5;
  a.trigger('match:rematch');
  assert.equal(room.game.rematchVotes.white, true);
  assert.equal(room.game.scores.white, 5);
  assert.equal(room.game.winner, 'white');
  b.trigger('match:rematch');
  assert.equal(room.game.rematchVotes.white, false);
  assert.equal(room.game.scores.white, 0);
  assert.equal(room.game.winner, null);
  assert.equal(room.game.turn, 'white'); // Önceki maçın kazananı.
});

test('odadan çıkış odanın kapanmasını ve iki oyuncunun bilgilendirilmesini sağlar', () => {
  const { a, b, rooms, roomCode } = setupPair();
  a.trigger('room:leave');
  assert.equal(rooms.has(roomCode), false);
  assert.match(b.last('room:closed').reason, /oda kapatıldı/i);
  assert.equal(b.rooms.has(roomCode), false);
  b.trigger('dice:roll');
  assert.equal(rooms.has(roomCode), false);
});

test('tekrar bağlanınca eski soket devreden çıkarılır', () => {
  const { createSocket, a, b, room, roomCode } = setupPair();
  const duplicate = createSocket('duplicate');
  duplicate.trigger('player:reconnect', { playerToken: 'a'.repeat(36), autoDice: false });
  assert.equal(room.players.white.socketId, 'duplicate');
  assert.equal(duplicate.last('room:joined').roomCode, roomCode);
  // Uyarı olayı ilk sekmeye gitmeli; eski sekme artık oyuna müdahale edemez.
  assert.equal(a.events.some(event => event.name === 'room:session-taken'), true);
  const count = room.chat.length;
  a.trigger('chat:send', { text: 'Gizli hamle' });
  assert.equal(room.chat.length, count);
  b.trigger('room:leave');
});

test('rakip kopunca otomatik zar durur ve yeniden katıldığında devam eder', () => {
  const { a, b, room, roomCode, advance, createSocket } = setupPair({ autoDice: true });
  b.trigger('disconnect');
  advance(3000);
  assert.equal(room.game.pendingState, null);
  assert.equal(room.players.black.connected, false);
  const b2 = createSocket('b2');
  b2.trigger('room:join', { roomCode, playerToken: 'b'.repeat(36), autoDice: true });
  assert.equal(room.players.black.connected, true);
  advance(2000);
  assert.ok(room.game.pendingState);
});


test('iki kat teklifi kabul edilince mars 4 puan olur, sonraki eli yine kazanan açar', () => {
  const { a, b, room, roomCode, helpers } = setupPair({ score: 5 });
  room.game.state = separatedState();
  a.trigger('double:offer');
  b.trigger('double:respond', { accept: true });
  assert.equal(room.game.roundMultiplier, 2);
  helpers.awardRoundTo(roomCode, room, 'black');
  assert.equal(room.game.scores.black, 4);
  assert.equal(room.game.turn, 'black');
  assert.equal(room.game.winner, null);
});

test('teklif beklerken rakip koparsa teklif iptal edilir, dönüşte tekrar oynanır', () => {
  const { a, b, room, advance, createSocket, roomCode } = setupPair({ autoDice: true });
  room.game.state = separatedState();
  a.trigger('double:offer');
  b.trigger('disconnect');
  assert.equal(room.game.doubleOffer, null);
  advance(9000);
  assert.equal(room.game.pendingState, null);
  const b2 = createSocket('b2');
  b2.trigger('player:reconnect', { playerToken: 'b'.repeat(36), autoDice: true });
  advance(4000);
  assert.equal(b2.last('room:joined').roomCode, roomCode);
  assert.ok(room.game.pendingState);
});

test('bağlantısı düşmüş oyuncu kimliğiyle odadan çıkılabilir', () => {
  const { a, b, roomCode, rooms, createSocket } = setupPair();
  a.trigger('disconnect');
  const newSocket = createSocket('offline-leave');
  newSocket.trigger('room:leave', { playerToken: 'a'.repeat(36) });
  assert.equal(rooms.has(roomCode), false);
  assert.match(b.last('room:closed').reason, /oda kapatıldı/i);
});

test('zar mantığı ile taş toplama ve vurma temel kural kontrolleri', () => {
  const state = gameRules.createInitialState();
  assert.equal(state.points.reduce((total, n) => total + Math.max(n, 0), 0), 15);
  assert.equal(state.points.reduce((total, n) => total + Math.min(n, 0), 0), -15);
  const hitState = gameRules.createInitialState();
  hitState.points.fill(0);
  hitState.points[8] = 1;
  hitState.points[7] = -1;
  const hit = gameRules.applyMove(hitState, 'white', { from: 8, to: 7 });
  assert.equal(hit.points[7], 1);
  assert.equal(hit.bar.black, 1);
  assert.equal(hitState.points[7], -1); // Orijinal veri değişmemeli.
  assert.equal(gameRules.canBearOffFrom(hit, 'white', 7, 6), false);
  const nearEnd = separatedState();
  nearEnd.points[3] = 0;
  nearEnd.points[0] = 1;
  nearEnd.off.white = 14;
  assert.equal(gameRules.canBearOffFrom(nearEnd, 'white', 0, 1), true);
  assert.equal(gameRules.isGameWon(gameRules.applyMove(nearEnd, 'white', { from: 0, to: 'off' })), 'white');
});


test('siyah oyuncu maçı kazanınca rövanşa da siyah başlar', () => {
  const { a, b, room } = setupPair();
  room.game.winner = 'black';
  b.trigger('match:rematch');
  a.trigger('match:rematch');
  assert.equal(room.game.turn, 'black');
  assert.equal(room.game.winner, null);
});
