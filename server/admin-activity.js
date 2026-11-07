'use strict';

// Yönetici etkinlik günlüğü: bilinçli olarak IP, şifre, cookie, oyuncu tokenı ve sohbet içeriği tutulmaz.
const MAX_EVENTS = 1200;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_TYPES = new Set([
  'site_visit', 'site_leave', 'register', 'login', 'logout',
  'room_created', 'room_joined', 'room_reconnected', 'room_closed',
  'match_started', 'match_finished', 'match_interrupted',
  'spectator_joined', 'spectator_left', 'friend_invite'
]);
function clean(value, limit = 64) {
  return typeof value === 'string' ? value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}
class ActivityLog {
  constructor() { this.entries = []; }
  append(type, actor = 'Misafir', details = {}) {
    if (!ALLOWED_TYPES.has(type)) return null;
    const item = { id: require('node:crypto').randomUUID(), at: Date.now(), type,
      actor: clean(actor, 32) || 'Misafir',
      roomCode: /^[A-Z0-9]{5}$/.test(details.roomCode || '') ? details.roomCode : null,
      description: clean(details.description, 120) };
    this.entries.push(item);
    this.prune();
    return item;
  }
  prune() {
    const cutoff = Date.now() - RETENTION_MS;
    this.entries = this.entries.filter(item => item.at >= cutoff).slice(-MAX_EVENTS);
  }
  serialize() { this.prune(); return this.entries.map(item => ({ ...item })); }
  restore(entries) {
    this.entries = Array.isArray(entries) ? entries.filter(item =>
      item && ALLOWED_TYPES.has(item.type) && Number.isFinite(item.at) &&
      item.at <= Date.now() + 60_000 && item.at >= Date.now() - RETENTION_MS &&
      typeof item.actor === 'string' && typeof item.id === 'string'
    ).map(item => ({ id: clean(item.id, 40), at: item.at, type: item.type,
      actor: clean(item.actor, 32), roomCode: /^[A-Z0-9]{5}$/.test(item.roomCode || '') ? item.roomCode : null,
      description: clean(item.description, 120) })).slice(-MAX_EVENTS) : [];
  }
  recent(limit = 100, type = '') {
    this.prune();
    const filtered = type && ALLOWED_TYPES.has(type) ? this.entries.filter(item => item.type === type) : this.entries;
    return filtered.slice(-Math.max(1, Math.min(200, Number(limit) || 100))).reverse();
  }
}
module.exports = { ActivityLog, MAX_EVENTS, RETENTION_MS };
