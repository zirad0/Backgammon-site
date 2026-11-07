'use strict';
const $ = id => document.getElementById(id);
let latest = null;
const labels = {
  site_visit: 'Siteye giriş', site_leave: 'Siteden ayrıldı', register: 'Kayıt oldu',
  login: 'Hesaba giriş', logout: 'Hesaptan çıkış', room_created: 'Oda oluşturdu',
  room_joined: 'Odaya katıldı', room_reconnected: 'Maça geri döndü', room_closed: 'Oda kapandı',
  match_started: 'Maç başladı', match_finished: 'Maç bitti', match_interrupted: 'Maç yarıda kaldı',
  spectator_joined: 'Maç izliyor', spectator_left: 'İzlemeyi bıraktı', friend_invite: 'Oyun daveti'
};
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}
function dt(value) {
  if (!Number.isFinite(Number(value))) return '—';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle:'short', timeStyle:'medium' }).format(new Date(Number(value)));
}
function clear(parent) { parent.replaceChildren(); }
function tableCell(row, text, cls = '') { row.appendChild(element('td', cls, text ?? '—')); }
function tag(text, cls) { return element('span', 'tag '+(cls || ''), text); }
function renderOnline(users) {
  const tbody = $('onlineRows'); clear(tbody);
  $('onlineBadge').textContent = `${users.length} bağlantı`;
  if (!users.length) { const tr=element('tr'); const td=element('td','empty','Şu anda bağlı kimse yok.');td.colSpan=4;tr.appendChild(td);tbody.appendChild(tr); return; }
  for (const item of users) {
    const tr=element('tr'); tableCell(tr,item.name || 'Misafir');
    const role=element('td');role.appendChild(tag(({player:'Oyuncu',spectator:'İzleyici',visitor:'Ziyaretçi'})[item.role]||'Ziyaretçi',item.role));tr.appendChild(role);
    tableCell(tr,item.roomCode || '—');tableCell(tr,dt(item.joinedAt));tbody.appendChild(tr);
  }
}
function renderRooms(rooms) {
  const node=$('roomCards');clear(node);$('roomBadge').textContent=`${rooms.length} oda`;
  if(!rooms.length){node.appendChild(element('p','empty','Henüz açık oda yok.'));return;}
  for (const room of rooms) {
    const card=element('article','room-card');const header=element('div','room-top');
    header.appendChild(element('strong','',room.roomCode));
    header.appendChild(tag(({waiting:'Rakip bekliyor',playing:'Oynanıyor',finished:'Bitti'})[room.status]||'—',room.status));
    card.appendChild(header);
    card.appendChild(element('p','room-meta',`${room.visibility==='public'?'Herkese açık':'Özel'} · Hedef: ${room.targetScore} · ${room.spectators} izleyici`));
    const names=(room.players||[]).map(p=>`${p.name} ${p.connected?'●':'○'}`).join('  vs  ');
    card.appendChild(element('div','room-bottom',names||'Bekleniyor'));
    card.appendChild(element('p','room-meta',`Skor: ${room.scores?.white??0} : ${room.scores?.black??0}`));
    node.appendChild(card);
  }
}
function renderEvents() {
  const events=latest?.events || [];
  const type=$('eventType').value;
  const query=$('eventSearch').value.trim().toLocaleLowerCase('tr-TR');
  const chosen=events.filter(item=>(!type||item.type===type) &&
    (!query||[item.actor,item.roomCode,item.description].some(val=>String(val||'').toLocaleLowerCase('tr-TR').includes(query))));
  const tbody=$('eventRows');clear(tbody);
  if (!chosen.length) {const tr=element('tr');const td=element('td','empty','Seçili ölçütlere uygun etkinlik yok.');td.colSpan=5;tr.appendChild(td);tbody.appendChild(tr);}
  for(const item of chosen){const tr=element('tr');tableCell(tr,dt(item.at));tableCell(tr,labels[item.type]||item.type);
    tableCell(tr,item.actor);tableCell(tr,item.roomCode||'—');tableCell(tr,item.description||'—');tbody.appendChild(tr);}
  $('eventCount').textContent=`${chosen.length} olay gösteriliyor (son ${events.length} olay içerisinden)`;
}
function render(data) {
  latest=data;
  const stats=data.stats||{};
  for(const [id,key] of Object.entries({connectionCount:'connections',playerCount:'players',matchCount:'activeMatches',watcherCount:'spectators',waitingCount:'waitingRooms',archivedCount:'archivedMatches'})) $(id).textContent=String(stats[key]??'—');
  renderOnline(data.online||[]); renderRooms(data.rooms||[]);renderEvents();
  $('updatedAt').textContent=`Son güncelleme: ${dt(data.generatedAt)}`;
}
async function refresh() {
  const btn=$('refreshBtn');btn.disabled=true;
  try{
    const result=await fetch('/api/admin/overview',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
    if(result.status===401||result.status===403){$('alert').hidden=false;$('alert').textContent='Yönetici yetkin yok veya oturumun sona erdi. Ana menüden giriş yapmalısın.';$('liveStatus').classList.remove('ok');$('liveStatus').lastChild.textContent=' Erişim yok';return;}
    if(!result.ok)throw new Error('İstatistikler alınamadı ('+result.status+')');
    const data=await result.json();$('alert').hidden=true;$('liveStatus').classList.add('ok');$('liveStatus').lastChild.textContent=' Canlı';render(data);
  }catch(err){$('alert').hidden=false;$('alert').textContent=err.message||'Bağlantı kurulamadı.';$('liveStatus').classList.remove('ok');$('liveStatus').lastChild.textContent=' Bağlantı hatası';}
  finally{btn.disabled=false;}
}
$('refreshBtn').addEventListener('click',refresh);
$('eventType').addEventListener('change',renderEvents);
$('eventSearch').addEventListener('input',renderEvents);
refresh();
setInterval(()=>{if(!document.hidden)refresh();},15000);
