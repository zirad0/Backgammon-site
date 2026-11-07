'use strict';

// Arkadaşlıklar yalnızca hesap UUID'leriyle tutulur; istemcinin gönderdiği
// ilişkiler/kimlikler yetki kanıtı olarak kullanılmaz.
class Friends {
  constructor() { this.relations = new Map(); }
  key(a, b) { return [a, b].sort().join(':'); }
  restore(records = []) {
    this.relations.clear();
    if (!Array.isArray(records)) return;
    for (const record of records.slice(0, 20000)) {
      if (!record || typeof record.a !== 'string' || typeof record.b !== 'string' || record.a === record.b ||
          !['pending', 'accepted'].includes(record.status) ||
          typeof record.requestedBy !== 'string' || ![record.a, record.b].includes(record.requestedBy)) continue;
      const [a, b] = [record.a, record.b].sort();
      this.relations.set(this.key(a, b), {
        a, b, status: record.status, requestedBy: record.requestedBy,
        createdAt: Number(record.createdAt) || Date.now()
      });
    }
  }
  serialize() { return [...this.relations.values()].map(item => ({ ...item })); }
  get(a, b) { return this.relations.get(this.key(a, b)) || null; }
  isFriend(a, b) { return !!(a && b && this.get(a, b)?.status === 'accepted'); }
  list(id) {
    const friends = [], incoming = [], outgoing = [];
    for (const item of this.relations.values()) {
      if (item.a !== id && item.b !== id) continue;
      const entry = { otherId: item.a === id ? item.b : item.a, createdAt: item.createdAt };
      if (item.status === 'accepted') friends.push(entry);
      else if (item.requestedBy === id) outgoing.push(entry);
      else incoming.push(entry);
    }
    const sorter = (a, b) => b.createdAt - a.createdAt;
    return { friends: friends.sort(sorter), incoming: incoming.sort(sorter), outgoing: outgoing.sort(sorter) };
  }
  request(from, to) {
    if (!from || !to || from === to) throw new Error('Kendine arkadaşlık isteği gönderemezsin.');
    const old = this.get(from, to);
    if (old?.status === 'accepted') throw new Error('Zaten arkadaşsınız.');
    if (old?.requestedBy === from) throw new Error('Arkadaşlık isteğin zaten bekliyor.');
    if (old) throw new Error('Bu oyuncunun sana gönderdiği isteği kabul edebilirsin.');
    if (this.list(from).friends.length >= 150 || this.list(to).friends.length >= 150)
      throw new Error('Arkadaş listesi dolu.');
    if (this.list(to).incoming.length >= 50 || this.list(from).outgoing.length >= 40)
      throw new Error('Çok fazla bekleyen arkadaşlık isteği var.');
    const [a, b] = [from, to].sort();
    this.relations.set(this.key(a, b), { a, b, requestedBy: from, status: 'pending', createdAt: Date.now() });
  }
  respond(me, other, accept) {
    const item = this.get(me, other);
    if (!item || item.status !== 'pending' || item.requestedBy === me)
      throw new Error('Kabul edilebilecek arkadaşlık isteği yok.');
    if (accept === true) item.status = 'accepted';
    else this.relations.delete(this.key(me, other));
  }
  remove(me, other) {
    const item = this.get(me, other);
    if (!item) throw new Error('Arkadaşlık veya istek bulunamadı.');
    this.relations.delete(this.key(me, other));
  }
}
module.exports = { Friends };
