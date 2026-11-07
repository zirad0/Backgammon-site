'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStore } = require('../server/postgres-store');

function createFakePool() {
  let stored = null;
  let failWrites = 0;
  let failReads = false;
  const queries = [];
  const pool = {
    queries,
    on() {},
    async query(sql, values) {
      queries.push({ sql, values });
      if (/CREATE TABLE/.test(sql)) return { rows: [] };
      if (/SELECT payload/.test(sql)) {
        if (failReads) throw new Error('temporary disconnection');
        return { rows: stored ? [{ payload: structuredClone(stored) }] : [] };
      }
      if (/INSERT INTO/.test(sql)) {
        if (failWrites-- > 0) throw new Error('temporary disconnection');
        stored = JSON.parse(values[0]);
        return { rowCount: 1 };
      }
      if (/SELECT 1/.test(sql)) return { rows: [{ '?column?': 1 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async end() { this.ended = true; },
    get state() { return stored && structuredClone(stored); },
    set failWrites(n) { failWrites = n; },
    set failReads(v) { failReads = v; }
  };
  return pool;
}
const sample = n => ({ version: 1, rooms: [{ roomCode: `ABC${n}`, game: { scores: { white: n, black: 0 } } }], history: [{ id: `m-${n}` }], nextChatId: n });

test('PostgreSQL şeması kurulur, maç kayıtları yeni süreç tarafından geri okunur', async () => {
  const pool = createFakePool();
  const first = new PostgresStore({ pool });
  assert.equal(await first.initialize(), null);
  const data = sample(1);
  await first.save(data);
  data.history.pop(); // Kayıt kuyruğunda nesne kopyası korunur.
  assert.equal(pool.state.history.length, 1);
  assert.equal(pool.queries.filter(q => /INSERT INTO/.test(q.sql)).length, 1);
  assert.equal(pool.queries[2].values.length, 1); // Parametreli SQL, kullanıcı verisi sorguya katılmaz.
  const second = new PostgresStore({ pool });
  assert.deepEqual(await second.initialize(), sample(1));
  await second.close();
});

test('PostgreSQL kayıtları aynı anda gelse bile son snapshot sırasıyla yazılır', async () => {
  const pool = createFakePool();
  const store = new PostgresStore({ pool });
  await store.initialize();
  await Promise.all([store.save(sample(1)), store.save(sample(2)), store.save(sample(3))]);
  assert.deepEqual(pool.state, sample(3));
  assert.equal(store.pendingWrites, 0);
  await store.flush();
  await store.close();
});

test('veritabanı kesilince oyun durur; tekrar bağlandığında yazı devam eder', async () => {
  const pool = createFakePool();
  const statuses = [];
  const errors = [];
  const store = new PostgresStore({ pool, onStatus: healthy => statuses.push(healthy),
    onError: (event, err) => errors.push(event), sleep: async () => {} });
  await store.initialize();
  pool.failWrites = 2;
  await store.save(sample(5));
  assert.deepEqual(pool.state, sample(5));
  assert.deepEqual(statuses, [true, false, true]);
  assert.equal(errors.length, 2);
  assert.equal(store.healthy, true);
  await store.close();
});

test('bozuk PostgreSQL verisi silinmez, başlangıç durdurulur', async () => {
  const pool = createFakePool();
  pool.query = async sql => {
    if (/CREATE TABLE/.test(sql)) return {};
    return { rows: [{ payload: { version: 9, rooms: [], history: [] } }] };
  };
  const store = new PostgresStore({ pool });
  await assert.rejects(store.initialize(), /geçersiz/i);
  assert.equal(store.healthy, false);
  await store.close();
});

test('başlangıçta PostgreSQL ulaşılamıyorsa servis hatayı gizlemez', async () => {
  const pool = createFakePool();
  pool.failReads = true;
  const store = new PostgresStore({ pool });
  await assert.rejects(store.initialize(), /temporary disconnection/);
  assert.equal(store.healthy, false);
  await store.close();
});

test('bağlantı tekrar sağlanınca sağlık kontrolü servisi açar', async () => {
  const pool = createFakePool();
  const store = new PostgresStore({ pool });
  await store.initialize();
  store.healthy = false;
  assert.equal(await store.ping(), true);
  assert.equal(store.healthy, true);
  await store.close();
});
