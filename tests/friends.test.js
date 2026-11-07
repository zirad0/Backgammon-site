'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Friends } = require('../server/friends');

test('arkadaşlık modeli kendine ve yinelenen isteklere izin vermez', () => {
  const graph = new Friends();
  assert.throws(() => graph.request('x', 'x'), /Kendine/);
  graph.request('x', 'y');
  assert.throws(() => graph.request('x', 'y'), /zaten bekliyor/);
  assert.throws(() => graph.request('y', 'x'), /gönderdiği isteği/);
  assert.throws(() => graph.respond('x', 'y', true), /yok/);
  graph.respond('y', 'x', true);
  assert.ok(graph.isFriend('y', 'x'));
  assert.throws(() => graph.request('x', 'y'), /Zaten/);
});

test('arkadaşlık istekleri, reddetme ve kaldırma sonrası silinir', () => {
  const graph = new Friends();
  graph.request('a', 'b');
  graph.respond('b', 'a', false);
  assert.equal(graph.list('a').outgoing.length, 0);
  graph.request('b', 'a');
  graph.respond('a', 'b', true);
  graph.remove('a', 'b');
  assert.equal(graph.list('b').friends.length, 0);
  assert.throws(() => graph.remove('b', 'a'), /bulunamadı/);
});

test('arkadaş verisi kaydedilir, geçersiz ilişkiler yüklenmez', () => {
  const graph = new Friends();
  graph.request('a', 'b');
  graph.respond('b', 'a', true);
  const snapshot = graph.serialize();
  const restored = new Friends();
  restored.restore([...snapshot, { a: 'x', b: 'x', requestedBy: 'x', status: 'accepted' }]);
  assert.equal(restored.isFriend('a', 'b'), true);
  assert.equal(restored.serialize().length, 1);
});
