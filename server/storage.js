'use strict';
// Tek-sunucu JSON anlık görüntüleri. Dosya, web root'u dışında ve atomik olarak yazılır.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'matches.json');
const filename = path.resolve(process.env.TAVLA_DATA_FILE || DEFAULT_FILE);

function loadSnapshot() {
  if (!fs.existsSync(filename)) return null;
  // Yarım yazılmış veya beklenmeyen dosyaları sessizce sıfırlamayız.
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!saved || saved.version !== 1 || !Array.isArray(saved.rooms) || !Array.isArray(saved.history)) {
    throw new Error(`Geçersiz Tavla kayıt dosyası: ${filename}`);
  }
  return saved;
}

function saveSnapshot(snapshot) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${require('node:crypto').randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, filename);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
module.exports = { loadSnapshot, saveSnapshot, filename };
