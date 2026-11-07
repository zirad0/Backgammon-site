'use strict';

// Tek aktif Node süreci için PostgreSQL kalıcı anlık görüntü deposu.
// Snapshot bir JSONB satırında tutulur: oda + maç geçmişi tek atomik yazıda korunur.
// Veritabanı ağı koparsa yazma kuyruğu sırayı koruyarak tekrar dener ve sunucu yeni
// oyun komutlarını geçici olarak durdurabilir. Pool enjekte edilerek test edilebilir.

const UPSERT_SQL = `
  INSERT INTO tavla_snapshots (id, payload, updated_at)
  VALUES (1, $1::jsonb, NOW())
  ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload, updated_at = NOW()
`;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tavla_snapshots (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

function validSnapshot(snapshot) {
  return !!snapshot && snapshot.version === 1 &&
    Array.isArray(snapshot.rooms) && Array.isArray(snapshot.history);
}

class PostgresStore {
  constructor({ connectionString, pool, onError = () => {}, onStatus = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!pool && !connectionString) throw new Error('DATABASE_URL eksik.');
    if (pool) {
      this.pool = pool;
    } else {
      // Yerel testler PostgreSQL bağlantısına ihtiyaç duymaz.
      const { Pool } = require('pg');
      this.pool = new Pool({
        connectionString,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 8_000,
        query_timeout: 10_000
      });
    }
    this.onError = onError;
    this.onStatus = onStatus;
    this.sleep = sleep;
    this.healthy = false;
    this.stopping = false;
    this.queue = Promise.resolve();
    this.pendingWrites = 0;
    if (typeof this.pool.on === 'function') {
      this.pool.on('error', error => {
        this.healthy = false;
        this.onStatus(false);
        this.onError('postgres_pool_error', error);
      });
    }
  }

  async initialize() {
    await this.pool.query(SCHEMA_SQL);
    const result = await this.pool.query('SELECT payload FROM tavla_snapshots WHERE id = 1');
    const snapshot = result.rows?.[0]?.payload ?? null;
    if (snapshot !== null && !validSnapshot(snapshot)) {
      throw new Error('PostgreSQL kayıt içeriği geçersiz. Mevcut verinin üzerine yazılmıyor.');
    }
    this.healthy = true;
    this.onStatus(true);
    return snapshot;
  }

  save(snapshot) {
    if (!validSnapshot(snapshot)) return Promise.reject(new Error('Geçersiz snapshot; yazma reddedildi.'));
    if (this.stopping) return Promise.reject(new Error('Veritabanı deposu kapanıyor.'));
    // Oyun state'i daha sonra değişebilir; kuyruğa konan veri sabitlenir.
    const payload = JSON.stringify(snapshot);
    this.pendingWrites++;
    const work = this.queue.then(async () => {
      let delay = 250;
      while (!this.stopping) {
        try {
          await this.pool.query(UPSERT_SQL, [payload]);
          if (!this.healthy) this.onStatus(true);
          this.healthy = true;
          return;
        } catch (error) {
          if (this.healthy) this.onStatus(false);
          this.healthy = false;
          this.onError('postgres_snapshot_write_failed', error);
          await this.sleep(delay);
          delay = Math.min(delay * 2, 10_000);
        }
      }
      throw new Error('Sunucu kapanırken veritabanına kayıt tamamlanamadı.');
    });
    // Hata başka yazıları engellemesin; çağıran work ile sonucu izleyebilir.
    this.queue = work.catch(() => {});
    return work.finally(() => { this.pendingWrites--; });
  }

  async ping() {
    if (this.stopping || this.pendingWrites > 0) return false;
    try {
      await this.pool.query('SELECT 1');
      if (!this.healthy) this.onStatus(true);
      this.healthy = true;
      return true;
    } catch (error) {
      if (this.healthy) this.onStatus(false);
      this.healthy = false;
      this.onError('postgres_healthcheck_failed', error);
      return false;
    }
  }

  async flush() {
    await this.queue;
    if (!this.healthy) throw new Error('PostgreSQL bağlantısı sağlıklı değil.');
  }

  async close() {
    this.stopping = true;
    await this.queue;
    if (typeof this.pool.end === 'function') await this.pool.end();
  }
}

module.exports = { PostgresStore, validSnapshot, SCHEMA_SQL, UPSERT_SQL };
