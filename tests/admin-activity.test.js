'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityLog, MAX_EVENTS, RETENTION_MS } = require('../server/admin-activity');

test('yönetici etkinliği yalnızca izinli türleri ve güvenli metni saklar', () => {
  const log = new ActivityLog();
  assert.equal(log.append('unknown', 'test'), null);
  const entry = log.append('room_joined', 'Zirad\nINJECTION', {
    roomCode: 'AB123', description: 'Özel\r\noda', password: 'secret', token: 'dont-store', ip: '127.0.0.1'
  });
  assert.equal(entry.roomCode, 'AB123');
  assert.equal(entry.actor, 'Zirad INJECTION');
  assert.equal(entry.description, 'Özel  oda');
  assert.equal(JSON.stringify(log.serialize()).includes('dont-store'), false);
  assert.equal(JSON.stringify(log.serialize()).includes('127.0.0.1'), false);
});

test('etkinlikler sayıyla sınırlanır ve eski kayıtlar temizlenir', () => {
  const log = new ActivityLog();
  for (let i = 0; i < MAX_EVENTS + 20; i++) log.append('site_visit', 'Misafir');
  assert.equal(log.recent(MAX_EVENTS + 50).length, 200); // tek sorgunun üst limiti
  assert.equal(log.serialize().length, MAX_EVENTS);
  log.entries.push({ id:'expired', at: Date.now() - RETENTION_MS - 100, type:'login', actor:'X' });
  assert.equal(log.serialize().some(e => e.id === 'expired'), false);
});

test('etkinlik kaydı yeniden yüklendiğinde geçersiz tür veya tarihi içeri almaz', () => {
  const log = new ActivityLog();
  log.restore([{ id:'good',at:Date.now(),type:'login',actor:'Zirad',roomCode:null,description:'' },
    { id:'bad',at:Date.now(),type:'malicious',actor:'Unknown' }]);
  assert.equal(log.recent()[0].actor, 'Zirad');
  assert.equal(log.serialize().length, 1);
});
