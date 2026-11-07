const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gameRules = require('../server/game');

function harness(initialSnapshot = null) {
  let savedSnapshot = initialSnapshot ? structuredClone(initialSnapshot) : null;
  const fakeStorage = {
    loadSnapshot: () => savedSnapshot && structuredClone(savedSnapshot),
    saveSnapshot: snapshot => { savedSnapshot = structuredClone(snapshot); }
  };
  const sockets = new Map();
  const callbacks = new Map();
  const timers = new Map();
  let currentTime = 0;
  let nextTimerId = 1;
  let io;

  class FakeSocket {
    constructor(id, cookie = null) {
      this.id = id;
      this.request = { headers: { cookie: cookie || '' } };
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
    constructor(_server, options) { this.options = options; this.sockets = { sockets }; io = this; }
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
      : name === './accounts' ? require('../server/accounts')
      : name === './friends' ? require('../server/friends')
      : name === './storage' ? fakeStorage
      : nativeRequire(name),
    __dirname: path.join(__dirname, '..', 'server'),
    URL,
    console: { log() {} }, process: { env: {} },
    setTimeout: stubTimeout, clearTimeout: id => timers.delete(id),
    setInterval: () => ({ unref() {} })
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8') +
    '\n globalThis.__test = { rooms, accounts, archiveMatch, getAccountStats, persistAll, awardRoundTo, maybeStartTurnRoll, checkSocketOrigin, friends };', context);
  return { createSocket: (id, cookie) => new FakeSocket(id, cookie), advance, rooms: context.__test.rooms, io, helpers: context.__test, snapshot: () => structuredClone(savedSnapshot) };
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
  newSocket.trigger('player:reconnect', { playerToken: 'a'.repeat(36) });
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

test('herkese açık bekleyen odalar listelenir, özel odalar listelenmez', () => {
  const h = harness();
  const observer = h.createSocket('spectator');
  assert.deepEqual(observer.last('rooms:list'), []);
  const privateHost = h.createSocket('privateHost');
  privateHost.trigger('room:create', {
    name: 'Gizli', visibility: 'private', playerToken: 'x'.repeat(36)
  });
  assert.equal(observer.last('rooms:list').length, 0);
  const host = h.createSocket('publicHost');
  host.trigger('room:create', {
    name: 'Açık Ev', visibility: 'public', targetScore: 7, playerToken: 'y'.repeat(36)
  });
  const publicRoom = host.last('room:joined').roomCode;
  const list = observer.last('rooms:list');
  assert.equal(list.length, 1);
  assert.equal(list[0].roomCode, publicRoom);
  assert.equal(list[0].targetScore, 7);
  assert.equal(list[0].players[0].name, 'Açık Ev');
  assert.equal(list[0].playerCount, 1);
  assert.equal(JSON.stringify(list).includes('playerToken'), false);
  assert.equal(JSON.stringify(list).includes('socketId'), false);
  const freshVisitor = h.createSocket('freshVisitor');
  assert.equal(freshVisitor.last('rooms:list')[0].roomCode, publicRoom);
  freshVisitor.trigger('rooms:request');
  assert.equal(freshVisitor.last('rooms:list')[0].roomCode, publicRoom);
});

test('herkese açık odaya ikinci oyuncu girince oda listeden anında kalkar', () => {
  const h = harness();
  const host = h.createSocket('host');
  const visitor = h.createSocket('visitor');
  host.trigger('room:create', { name: 'Ev Sahibi', visibility: 'public', playerToken: 'w'.repeat(36) });
  const code = host.last('room:joined').roomCode;
  assert.equal(visitor.last('rooms:list').length, 1);
  visitor.trigger('room:join', { roomCode: code, name: 'Misafir', playerToken: 'z'.repeat(36) });
  assert.equal(visitor.last('room:joined').color, 'black');
  assert.equal(visitor.last('rooms:list').length, 0);
  assert.equal(h.rooms.get(code).hasStarted, true);
  visitor.trigger('disconnect');
  assert.equal(host.last('rooms:list').length, 0); // Başlamış oda tekrar açılmamalı.
  const late = h.createSocket('late');
  assert.equal(late.last('rooms:list').length, 0);
});

test('bekleyen herkese açık oda bağlantı kesilince gizlenir, geri gelince görünür', () => {
  const h = harness();
  const host = h.createSocket('host');
  const spectator = h.createSocket('spectator');
  const token = 'r'.repeat(36);
  host.trigger('room:create', { name: 'Çevrimiçi', visibility: 'public', playerToken: token });
  const code = host.last('room:joined').roomCode;
  assert.equal(spectator.last('rooms:list').length, 1);
  host.trigger('disconnect');
  assert.equal(spectator.last('rooms:list').length, 0);
  const sameHost = h.createSocket('rehost');
  sameHost.trigger('player:reconnect', { playerToken: token });
  assert.equal(spectator.last('rooms:list')[0].roomCode, code);
  sameHost.trigger('room:leave', { playerToken: token });
  assert.equal(spectator.last('rooms:list').length, 0);
});

test('geçersiz görünürlük varsayılan özel olur ve özel odaya kodla katılınabilir', () => {
  const h = harness();
  const a = h.createSocket('a');
  const b = h.createSocket('b');
  a.trigger('room:create', { name: 'Test', visibility: 'everyone', playerToken: 'c'.repeat(36) });
  const code = a.last('room:joined').roomCode;
  assert.equal(h.rooms.get(code).visibility, 'private');
  assert.deepEqual(b.last('rooms:list'), []);
  b.trigger('room:join', { roomCode: code, playerToken: 'd'.repeat(36) });
  assert.equal(b.last('room:joined').roomCode, code);
  assert.equal(a.last('state:update').visibility, 'private');
});

test('hile denemesi: sahte zar, geçersiz hamle ve rakip sırasına müdahale reddedilir', () => {
  const { a, b, room, createSocket, advance } = setupPair({ autoDice: false });
  const intruder = createSocket('outsider');
  const original = structuredClone(room.game.state);
  intruder.trigger('dice:roll');
  intruder.trigger('move:play', { actionId: 'fake', from: 23, to: 'off' });
  b.trigger('dice:roll'); // Beyaz sıra kendisindeyken siyah zar atamaz.
  assert.equal(room.game.pendingState, null);
  a.trigger('dice:roll');
  advance(900);
  assert.ok(room.game.pendingState);
  const expected = structuredClone(room.game.pendingState);
  b.trigger('turn:reset');
  b.trigger('turn:confirm');
  b.trigger('move:play', { from: 23, to: 'off' });
  a.trigger('move:play', { actionId: 'made-up', from: 23, to: 'off' });
  a.trigger('turn:confirm'); // Kullanılabilir zar varken sıra onaylanamaz.
  assert.deepEqual(room.game.pendingState, expected);
  assert.deepEqual(room.game.state, original);
  assert.equal(room.game.turn, 'white');
});

test('bağlantı koparsa yarım taş animasyonu durur ve aynı hamle güvenle oynanabilir', () => {
  const { a, room, advance, roomCode, createSocket } = setupPair();
  room.game.pendingState = gameRules.cloneState(room.game.state);
  room.game.turnStartState = gameRules.cloneState(room.game.state);
  room.game.dice = [3, 4];
  room.game.turnStartDice = [3, 4];
  const option = gameRules.legalMoveOptions(room.game.pendingState, 'white', room.game.dice)[0];
  assert.ok(option);
  a.trigger('move:play', { actionId: option.id });
  assert.equal(room.game.animating, true);
  a.trigger('disconnect');
  assert.equal(room.game.animating, false);
  advance(5000);
  assert.deepEqual(room.game.pendingState, room.game.state);
  const replacement = createSocket('replacement');
  replacement.trigger('player:reconnect', { playerToken: 'a'.repeat(36) });
  replacement.trigger('move:play', { actionId: option.id });
  advance(1000);
  assert.notDeepEqual(room.game.pendingState, room.game.state);
  assert.equal(replacement.last('room:joined').roomCode, roomCode);
});

test('eski oturum yeni oturumu odadan çıkaramaz', () => {
  const { a, b, roomCode, rooms, createSocket } = setupPair();
  const a2 = createSocket('replacement');
  a2.trigger('player:reconnect', { playerToken: 'a'.repeat(36) });
  a.trigger('room:leave', { playerToken: 'a'.repeat(36) });
  assert.ok(rooms.has(roomCode));
  assert.match(a.last('room:error'), /yeniden bağla/i);
  assert.equal(b.last('room:closed'), undefined);
  a2.trigger('room:leave');
  assert.equal(rooms.has(roomCode), false);
});

test('yeniden başlatma sonrası maç durumu, iki oyuncu ve özel oda korunur', () => {
  const first = setupPair({ score: 7 });
  first.room.game.turn = 'black';
  first.room.game.scores = { white: 3, black: 2 };
  first.room.game.pendingState = gameRules.cloneState(first.room.game.state);
  first.room.game.turnStartState = gameRules.cloneState(first.room.game.state);
  first.room.game.dice = [3, 4];
  first.room.game.turnStartDice = [3, 4];
  first.a.trigger('settings:autoDice', { enabled: false }); // kalıcı kayıt oluştur
  const saved = first.snapshot();
  assert.equal(saved.version, 1);
  assert.equal(saved.rooms[0].players.white.playerToken, 'a'.repeat(36));
  assert.equal(JSON.stringify(saved).includes('socketId'), false);
  const second = harness(saved);
  const recovered = second.rooms.get(first.roomCode);
  assert.ok(recovered);
  assert.equal(recovered.players.white.connected, false);
  assert.equal(recovered.players.black.connected, false);
  assert.deepEqual(recovered.game.scores, { white: 3, black: 2 });
  assert.deepEqual(recovered.game.dice, [3, 4]);
  const newcomer = second.createSocket('other');
  newcomer.trigger('room:join', { roomCode: first.roomCode, playerToken: 'c'.repeat(36) });
  assert.match(newcomer.last('room:error'), /dolu/i);
  const a2 = second.createSocket('owner');
  const b2 = second.createSocket('opponent');
  a2.trigger('player:reconnect', { playerToken: 'a'.repeat(36) });
  b2.trigger('player:reconnect', { playerToken: 'b'.repeat(36) });
  assert.equal(a2.last('room:joined').color, 'white');
  assert.equal(b2.last('room:joined').color, 'black');
  assert.equal(a2.last('state:update').game.turn, 'black');
  assert.deepEqual(a2.last('state:update').game.dice, [3, 4]);
});

test('15 dakika içinde dönmeyen oyuncunun odası kapanır ve yarım kalan maç kayda girer', () => {
  const { a, b, roomCode, rooms, advance } = setupPair();
  a.trigger('disconnect');
  advance(14 * 60 * 1000);
  assert.ok(rooms.has(roomCode));
  advance(60 * 1000 + 1);
  assert.equal(rooms.has(roomCode), false);
  assert.match(b.last('room:closed').reason, /15 dakika/i);
  b.trigger('history:request', { playerToken: 'b'.repeat(36) });
  const history = b.last('history:list');
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'interrupted');
  assert.equal(JSON.stringify(history).includes('playerTokens'), false);
});

test('biten maçın sonucu kaydedilir ve yalnızca ilgili oyuncu geçmişi görür', () => {
  const { a, b, roomCode, room, snapshot, createSocket, helpers } = setupPair({ score: 3 });
  room.game.scores.white = 2;
  helpers.awardRoundTo(roomCode, room, 'white', { forcedPoints: 2 });
  // awardRoundTo içinde maç kazanıldı; normal yayında emitRoomState ile kalıcı olur.
  b.trigger('settings:autoDice', { enabled: false });
  a.trigger('history:request', { playerToken: 'a'.repeat(36) });
  b.trigger('history:request', { playerToken: 'b'.repeat(36) });
  assert.equal(a.last('history:list')[0].winner, 'white');
  assert.equal(a.last('history:list')[0].status, 'finished');
  assert.equal(b.last('history:list').length, 1);
  const stranger = createSocket('stranger');
  stranger.trigger('history:request', { playerToken: 'c'.repeat(36) });
  assert.deepEqual(stranger.last('history:list'), []);
  assert.equal(snapshot().history.length, 1);
  // Rövanş: yeni maç, yeni arşiv kaydı.
  a.trigger('match:rematch');
  b.trigger('match:rematch');
  helpers.awardRoundTo(roomCode, room, 'black', { forcedPoints: 3 });
  b.trigger('settings:autoDice', { enabled: false });
  b.trigger('history:request', { playerToken: 'b'.repeat(36) });
  assert.equal(b.last('history:list').length, 2);
  assert.notEqual(b.last('history:list')[0].id, b.last('history:list')[1].id);
});

test('sunucu zarı geçerli ve rastgele; istemci sonucu belirleyemez', () => {
  for (let i = 0; i < 100; i++) {
    const rolled = gameRules.rollDice();
    assert.equal(rolled.pair.length, 2);
    assert.ok(rolled.pair.every(v => Number.isInteger(v) && v >= 1 && v <= 6));
    assert.equal(rolled.dice.length, rolled.pair[0] === rolled.pair[1] ? 4 : 2);
  }
});


test('hatalı websocket veri tipleri ve çok sık istek güvenle reddedilir', () => {
  const { a, b, room, rooms } = setupPair({ autoDice: false });
  const before = gameRules.cloneState(room.game.state);
  a.trigger('move:play', { from: { toString: 7 }, to: ['off'] });
  a.trigger('move:play', { actionId: { complex: true } });
  a.trigger('chat:send', { text: { toString: 42 } });
  a.trigger('chat:send', { text: 'x'.repeat(100_000) });
  b.trigger('room:join', { roomCode: { toString: 42 }, playerToken: 'b'.repeat(36) });
  assert.match(b.last('room:error'), /Geçersiz oda kodu/);
  for (let i = 0; i < 250; i++) a.trigger('move:play', { actionId: 'bad' });
  assert.deepEqual(room.game.state, before);
  assert.equal(rooms.size, 1);
});


test('WebSocket isteği aynı siteden gelmeli; yabancı origin reddedilir', () => {
  const h = harness();
  const allow = h.io.options.allowRequest;
  const check = headers => {
    let result;
    allow({ headers }, (error, allowed) => { result = { error, allowed }; });
    return result;
  };
  assert.equal(check({ host: 'game.example.com', origin: 'https://game.example.com' }).allowed, true);
  assert.equal(check({ host: 'game.example.com', origin: 'https://phishing.example.com' }).allowed, false);
  assert.equal(check({ host: 'game.example.com', origin: 'javascript:evil()' }).allowed, false);
  assert.equal(check({ host: 'game.example.com' }).allowed, true);
  assert.equal(h.io.options.maxHttpBufferSize, 64 * 1024);
});


test('kayıtlı kullanıcının adı korunur, misafir aynı adı taklit edemez', () => {
  const h = harness();
  const { token, user } = h.helpers.accounts.register('Zirad', 'Guv3nliSifre!');
  const member = h.createSocket('member', `tavla_session=${token}`);
  const guest = h.createSocket('guest');
  guest.trigger('room:create', { name: 'zirad', targetScore: 5, playerToken: 'b'.repeat(48), autoDice: false });
  assert.match(guest.last('room:error'), /kayıtlı bir kullanıcıya/);
  member.trigger('room:create', { name: 'BaşkaAd', targetScore: 5, playerToken: 'a'.repeat(48), autoDice: false });
  const code = member.last('room:joined').roomCode;
  assert.equal(h.rooms.get(code).players.white.name, 'Zirad');
  assert.equal(h.rooms.get(code).players.white.accountId, user.id);
  assert.equal(JSON.stringify(member.last('state:update')).includes('accountId'), false);
});

test('kayıtlı oda gizli tokenla ele geçirilemez, hesap başka cihazdan geri bağlanır', () => {
  const h = harness();
  const { token, user } = h.helpers.accounts.register('Zirad', 'Guv3nliSifre!');
  const member = h.createSocket('member', `tavla_session=${token}`);
  member.trigger('room:create', { name: 'Zirad', playerToken: 'a'.repeat(48), autoDice: false });
  const code = member.last('room:joined').roomCode;
  const thief = h.createSocket('thief');
  thief.trigger('player:reconnect', { playerToken: 'a'.repeat(48) });
  assert.equal(thief.events.some(event => event.name === 'player:reconnect-missing'), true);
  assert.equal(h.rooms.get(code).players.white.socketId, 'member');
  const alternateToken = h.helpers.accounts.login('zirad', 'Guv3nliSifre!').token;
  const secondDevice = h.createSocket('secondDevice', `tavla_session=${alternateToken}`);
  secondDevice.trigger('player:reconnect', { playerToken: 'c'.repeat(48), autoDice: false });
  assert.equal(secondDevice.last('room:joined').roomCode, code);
  assert.equal(h.rooms.get(code).players.white.socketId, 'secondDevice');
  assert.equal(h.rooms.get(code).players.white.accountId, user.id);
  assert.equal(member.last('room:session-taken'), undefined);
});

test('profil galibiyet, mağlubiyet ve geçmiş maçları oturum hesabıyla eşleştirir', () => {
  const h = harness();
  const accountWhite = h.helpers.accounts.register('Zirad', 'Guv3nliSifre!');
  const accountBlack = h.helpers.accounts.register('OyuncuTwo', 'Guv3nliSifre!');
  const white = h.createSocket('white', `tavla_session=${accountWhite.token}`);
  const black = h.createSocket('black', `tavla_session=${accountBlack.token}`);
  white.trigger('room:create', { name: 'Impersonated', targetScore: 3, playerToken: 'a'.repeat(48), autoDice: false });
  const code = white.last('room:joined').roomCode;
  black.trigger('room:join', { roomCode: code, name: 'Other', playerToken: 'b'.repeat(48), autoDice: false });
  h.helpers.awardRoundTo(code, h.rooms.get(code), 'black', { forcedPoints: 3 });
  assert.equal(h.helpers.getAccountStats(accountWhite.user.id).losses, 1);
  assert.equal(h.helpers.getAccountStats(accountWhite.user.id).games, 1);
  assert.equal(h.helpers.getAccountStats(accountBlack.user.id).wins, 1);
  assert.equal(h.helpers.getAccountStats(accountBlack.user.id).winRate, 100);
  black.trigger('history:request', { playerToken: 'b'.repeat(48) });
  assert.equal(black.last('history:list').length, 1);
  assert.equal(JSON.stringify(black.last('history:list')).includes('playerTokens'), false);
  h.helpers.persistAll();
  const snap = h.snapshot();
  assert.equal(snap.history[0].userIds.black, accountBlack.user.id);
  assert.equal(snap.users.length, 2);
  assert.equal(snap.users[0].passwordHash.includes('Guv3nli'), false);
  assert.equal(snap.sessions[0].hash.includes(accountWhite.token), false);
});

// v16: oda sahibinin izin verdiği maçlarda salt-okunur seyirci erişimi.
function makeSpectatablePair({ visibility = 'public', permission = true } = {}) {
  const h = harness();
  const a = h.createSocket('host');
  const b = h.createSocket('opponent');
  const v = h.createSocket('viewer');
  a.trigger('room:create', {
    name: 'Beyaz', visibility, allowSpectators: permission,
    targetScore: 7, playerToken: 'a'.repeat(36), autoDice: false
  });
  const roomCode = a.last('room:joined').roomCode;
  b.trigger('room:join', { roomCode, name: 'Siyah', playerToken: 'b'.repeat(36), autoDice: false });
  return { ...h, a, b, v, roomCode, room: h.rooms.get(roomCode) };
}

test('izin verilmeyen maçlar listelenmez, izlenemez', () => {
  const { v, roomCode, room } = makeSpectatablePair({ permission: false });
  assert.equal(room.allowSpectators, false);
  assert.equal(v.last('matches:list').length, 0);
  v.trigger('viewer:watch', { roomCode });
  assert.match(v.last('room:error'), /izlemeye açık değil/i);
  assert.equal(v.last('viewer:joined'), undefined);
  assert.equal(room.spectators.size, 0);
});

test('herkese açık izlenebilir maç listelenir, oyuncuların skorlarını gösterir; gizli maç listelenmez', () => {
  const publicMatch = makeSpectatablePair();
  const list = publicMatch.v.last('matches:list');
  assert.equal(list.length, 1);
  assert.equal(list[0].roomCode, publicMatch.roomCode);
  assert.equal(list[0].players.white, 'Beyaz');
  assert.equal(list[0].players.black, 'Siyah');
  assert.equal(list[0].targetScore, 7);
  assert.equal(JSON.stringify(list).includes('playerToken'), false);
  assert.equal(publicMatch.v.last('rooms:list').length, 0); // Maç başlamış odalar bekleme listesinde görünmez.
  const privateMatch = makeSpectatablePair({ visibility: 'private' });
  assert.deepEqual(privateMatch.v.last('matches:list'), []);
  privateMatch.v.trigger('viewer:watch', { roomCode: privateMatch.roomCode });
  assert.equal(privateMatch.v.last('viewer:joined').roomCode, privateMatch.roomCode);
});

test('seyirci sadece canlı oyun durumunu alır; oyuncu sohbeti ve yetki alanları gizlidir', () => {
  const { a, b, v, room, roomCode, advance } = makeSpectatablePair();
  a.trigger('chat:send', { text: 'Yalnızca rakibime özel' });
  v.trigger('viewer:watch', { roomCode });
  const snapshot = v.last('state:update');
  assert.equal(v.last('viewer:joined').roomCode, roomCode);
  assert.equal(snapshot.roomCode, roomCode);
  assert.equal(snapshot.spectatorCount, 1);
  assert.deepEqual(snapshot.chat, []);
  assert.deepEqual(snapshot.game.moveOptions, []);
  assert.equal(snapshot.game.canConfirm, false);
  assert.equal(snapshot.game.canOfferDouble, false);
  assert.equal(v.rooms.has(roomCode), false);
  assert.equal(v.rooms.has(`watch:${roomCode}`), true);
  assert.equal(JSON.stringify(snapshot).includes('playerToken'), false);
  assert.equal(a.last('viewer:count').spectatorCount, 1);
  const chatBefore = v.events.filter(event => event.name === 'chat:message').length;
  b.trigger('chat:send', { text: 'Saklı mesaj' });
  assert.equal(v.events.filter(event => event.name === 'chat:message').length, chatBefore);
  a.trigger('dice:roll');
  advance(1000);
  assert.ok(room.game.pendingState);
  assert.ok(v.events.some(event => event.name === 'dice:rolling'));
  assert.ok(v.last('state:update').game.rolledPair);
});

test('seyirci hamle, zar, 2x, sohbet, rövanş ve oda kapatmaya müdahale edemez', () => {
  const { v, a, room, roomCode } = makeSpectatablePair();
  v.trigger('viewer:watch', { roomCode });
  const oldState = structuredClone(room.game);
  const chatSize = room.chat.length;
  for (const [event, data] of [
    ['dice:roll', {}], ['move:play', { from: 23, to: 22 }],
    ['turn:confirm', {}], ['turn:reset', {}], ['double:offer', {}],
    ['double:respond', { accept: true }], ['chat:send', { text: 'Hile' }],
    ['match:rematch', {}], ['settings:autoDice', { enabled: false }], ['room:leave', {}]
  ]) v.trigger(event, data);
  assert.equal(JSON.stringify(room.game), JSON.stringify(oldState));
  assert.equal(room.chat.length, chatSize);
  assert.equal(a.last('room:closed'), undefined);
  assert.equal(v.last('room:joined'), undefined);
  assert.equal(v.last('room:error')?.includes('oyuncu oturumunu'), true);
});

test('izleyici çıkınca ve bağlantısı kopunca sayaç düşer, oda kapanmaz', () => {
  const { createSocket, room, roomCode, v, a, rooms } = makeSpectatablePair();
  const v2 = createSocket('viewer-two');
  v.trigger('viewer:watch', { roomCode });
  v2.trigger('viewer:watch', { roomCode });
  assert.equal(a.last('viewer:count').spectatorCount, 2);
  v.trigger('viewer:leave');
  assert.equal(v.last('viewer:left'), undefined); // veri içermeyen olay
  assert.equal(a.last('viewer:count').spectatorCount, 1);
  v2.trigger('disconnect');
  assert.equal(a.last('viewer:count').spectatorCount, 0);
  assert.equal(rooms.has(roomCode), true);
  assert.equal(room.spectators.size, 0);
});

test('izleyici tekrar bağlanır, izlerken oyuncu rolüne geçemez; oyuncu da izlemeye geçemez', () => {
  const { a, v, roomCode, room, createSocket } = makeSpectatablePair();
  v.trigger('viewer:watch', { roomCode });
  v.trigger('viewer:watch', { roomCode });
  assert.equal(room.spectators.size, 1);
  v.trigger('room:join', { roomCode, playerToken: 'v'.repeat(36) });
  assert.match(v.last('room:error'), /izlediğin maçtan çık/i);
  a.trigger('viewer:watch', { roomCode });
  assert.match(a.last('room:error'), /oynadığın odadan ayrıl/i);
  v.trigger('disconnect');
  const returned = createSocket('viewer-returned');
  returned.trigger('viewer:watch', { roomCode });
  assert.equal(returned.last('viewer:joined').roomCode, roomCode);
  assert.equal(a.last('viewer:count').spectatorCount, 1);
});

test('sunucu yeniden başlatılınca izleme izni kalır, seyirci oturumları yüklenmez', () => {
  const first = makeSpectatablePair({ visibility: 'private' });
  first.v.trigger('viewer:watch', { roomCode: first.roomCode });
  first.a.trigger('settings:autoDice', { enabled: false });
  const saved = first.snapshot();
  assert.equal(saved.rooms[0].allowSpectators, true);
  assert.equal(JSON.stringify(saved).includes('spectators'), false);
  const next = harness(saved);
  const room = next.rooms.get(first.roomCode);
  assert.equal(room.allowSpectators, true);
  assert.equal(room.spectators.size, 0);
  const view = next.createSocket('view-again');
  view.trigger('viewer:watch', { roomCode: first.roomCode });
  assert.equal(view.last('viewer:joined').roomCode, first.roomCode);
});

test('oda kapatılınca seyirciler ana menüye gönderilir', () => {
  const { v, a, roomCode } = makeSpectatablePair();
  v.trigger('viewer:watch', { roomCode });
  a.trigger('room:leave');
  assert.match(v.last('room:closed').reason, /oda kapatıldı/i);
  assert.equal(v.rooms.has(`watch:${roomCode}`), false);
});

test('maç kazanıldığı anda izlenebilir canlı maç listesinden kaldırılır', () => {
  const { a, v, roomCode, room, helpers } = makeSpectatablePair();
  assert.equal(v.last('matches:list').length, 1);
  room.game.scores.white = 6;
  helpers.awardRoundTo(roomCode, room, 'white', { forcedPoints: 2 });
  assert.equal(room.game.winner, 'white');
  assert.deepEqual(v.last('matches:list'), []);
  v.trigger('viewer:watch', { roomCode }); // Devam eden seyirci maçı izlemeye devam edebilir.
  assert.equal(v.last('viewer:joined').roomCode, roomCode);
  a.trigger('room:leave');
  assert.ok(v.last('room:closed'));
});

test('tek odada en fazla 60 izleyici olabilir', () => {
  const { createSocket, room, roomCode } = makeSpectatablePair();
  for (let i = 0; i < 60; i++) {
    const socket = createSocket(`watcher${i}`);
    socket.trigger('viewer:watch', { roomCode });
    assert.equal(socket.last('viewer:joined').roomCode, roomCode);
  }
  assert.equal(room.spectators.size, 60);
  const overflow = createSocket('viewer61');
  overflow.trigger('viewer:watch', { roomCode });
  assert.match(overflow.last('room:error'), /kapasitesi doldu/i);
  assert.equal(room.spectators.size, 60);
});

function loggedInFriends() {
  const h = harness();
  const alpha = h.helpers.accounts.register('AlphaUser', 'Test12345!');
  const beta = h.helpers.accounts.register('BetaUser', 'Test12345!');
  const gamma = h.helpers.accounts.register('GammaUser', 'Test12345!');
  const a = h.createSocket('alpha-sock', `tavla_session=${alpha.token}`);
  const b = h.createSocket('beta-sock', `tavla_session=${beta.token}`);
  const c = h.createSocket('gamma-sock', `tavla_session=${gamma.token}`);
  return { ...h, a, b, c, alpha, beta, gamma };
}

test('arkadaşlık araması, istek, kabul, çevrimiçi görünümü ve kalıcı snapshot', () => {
  const h = loggedInFriends();
  h.a.trigger('friends:search', { query: 'beta' });
  assert.equal(h.a.last('friends:results')[0].user.username, 'BetaUser');
  assert.equal(h.a.last('friends:results')[0].status, 'none');
  h.a.trigger('friends:request', { userId: h.beta.user.id });
  assert.equal(h.b.last('friends:state').incoming.length, 1);
  assert.equal(h.a.last('friends:state').outgoing.length, 1);
  assert.equal(h.snapshot().friends.length, 1);
  h.b.trigger('friends:respond', { userId: h.alpha.user.id, accept: true });
  assert.equal(h.a.last('friends:state').friends[0].user.username, 'BetaUser');
  assert.equal(h.b.last('friends:state').friends[0].online, true);
  assert.equal(h.snapshot().friends[0].status, 'accepted');
  const restored = harness(h.snapshot());
  assert.equal(restored.helpers.friends.isFriend(h.alpha.user.id, h.beta.user.id), true);
});

test('arkadaşlığı kabul etme, silme ve davetleri sahte hesap engeline takılır', () => {
  const h = loggedInFriends();
  h.c.trigger('friends:request', { userId: h.beta.user.id });
  h.a.trigger('friends:respond', { userId: h.gamma.user.id, accept: true });
  assert.match(h.a.last('friends:error'), /yok/);
  h.a.trigger('friends:invite', { userId: h.beta.user.id, playerToken: 'a'.repeat(40) });
  assert.match(h.a.last('friends:error'), /arkadaş/);
  assert.equal(h.a.last('room:joined'), undefined);
  h.b.trigger('friends:respond', { userId: h.gamma.user.id, accept: true });
  h.c.trigger('friends:profile', { userId: h.alpha.user.id });
  assert.match(h.c.last('friends:error'), /arkadaş/);
  h.c.trigger('friends:remove', { userId: h.beta.user.id });
  assert.equal(h.b.last('friends:state').friends.length, 0);
});

test('arkadaş daveti özel oda açar, hedef kullanıcıya iletilir ve yalnızca davet alan kabul eder', () => {
  const h = loggedInFriends();
  h.a.trigger('friends:request', { userId: h.beta.user.id });
  h.b.trigger('friends:respond', { userId: h.alpha.user.id, accept: true });
  h.a.trigger('friends:invite', { userId: h.beta.user.id, playerToken: 'a'.repeat(40), targetScore: 7, autoDice: false });
  const roomCode = h.a.last('room:joined').roomCode;
  assert.equal(h.rooms.get(roomCode).visibility, 'private');
  assert.equal(h.rooms.get(roomCode).game.targetScore, 7);
  const invitation = h.b.last('friends:invitations')[0];
  assert.equal(invitation.roomCode, roomCode);
  h.c.trigger('friends:invite:respond', { inviteId: invitation.id, accept: true });
  assert.match(h.c.last('friends:error'), /sona erdi/);
  h.b.trigger('friends:invite:respond', { inviteId: invitation.id, accept: true });
  assert.equal(h.b.last('friends:invite:ready').roomCode, roomCode);
  h.b.trigger('room:join', { roomCode, playerToken: 'b'.repeat(40), autoDice: false });
  assert.equal(h.rooms.get(roomCode).players.black.accountId, h.beta.user.id);
  assert.equal(h.b.last('room:joined').color, 'black');
});

test('oyun daveti arkadaş çevrimdışı ya da aktif odadaysa reddedilir', () => {
  const h = loggedInFriends();
  h.a.trigger('friends:request', { userId: h.beta.user.id });
  h.b.trigger('friends:respond', { userId: h.alpha.user.id, accept: true });
  h.b.trigger('room:create', { playerToken: 'b'.repeat(40), visibility: 'private' });
  h.a.trigger('friends:invite', { userId: h.beta.user.id, playerToken: 'a'.repeat(40) });
  assert.match(h.a.last('friends:error'), /odada/);
  assert.equal(h.a.last('room:joined'), undefined);
});

test('arkadaş olmayan oyuncu başka hesabın profilini göremez', () => {
  const h = loggedInFriends();
  h.c.trigger('friends:profile', { userId: h.alpha.user.id });
  assert.equal(h.c.last('friends:profile'), undefined);
  assert.match(h.c.last('friends:error'), /arkadaş/);
  h.a.trigger('friends:request', { userId: h.beta.user.id });
  h.b.trigger('friends:respond', { userId: h.alpha.user.id, accept: true });
  h.a.trigger('friends:profile', { userId: h.beta.user.id });
  assert.equal(h.a.last('friends:profile').user.username, 'BetaUser');
  assert.equal(h.a.last('friends:profile').user.passwordHash, undefined);
});

test('oda kapatılınca henüz kabul edilmemiş oyun daveti geçersizleşir', () => {
  const h = loggedInFriends();
  h.a.trigger('friends:request', { userId: h.beta.user.id });
  h.b.trigger('friends:respond', { userId: h.alpha.user.id, accept: true });
  h.a.trigger('friends:invite', { userId: h.beta.user.id, playerToken: 'a'.repeat(40) });
  assert.equal(h.b.last('friends:invitations').length, 1);
  h.a.trigger('room:leave');
  assert.equal(h.b.last('friends:invitations').length, 0);
});

test('aktif oturum kapatılınca çevrimiçi durumu diğer arkadaşta değişir', () => {
  const h = loggedInFriends();
  h.a.trigger('friends:request', { userId: h.beta.user.id });
  h.b.trigger('friends:respond', { userId: h.alpha.user.id, accept: true });
  assert.equal(h.a.last('friends:state').friends[0].online, true);
  h.b.disconnected = true;
  h.b.trigger('disconnect');
  assert.equal(h.a.last('friends:state').friends[0].online, false);
});
