# Tavla Online v17 — Render ve GitHub'a yayınlama

## Mevcut v16 sitesini güncelleme

1. **Mevcut PostgreSQL veritabanının yedeğini al.** v17 ilk açılışta v16 kayıtlarını okuyup yeni `friends` alanını boş olarak başlatır; hesap, oturum, oda ve maç geçmişi korunmalıdır. Yine de üretim verisinde değişiklik öncesinde yedek önemlidir.
2. ZIP içindeki `client/`, `server/`, `tests/`, `package.json`, `package-lock.json`, `.env.example`, `render.yaml`, `README.md` ve `YAYINLAMA-REHBERI.md` dosyalarını mevcut **Backgammon-site GitHub deponun köküne** yükle, eskilerini değiştir ve commit oluştur.
3. Render web servisinin Environment bölümündeki **`DATABASE_URL` değişkenini değiştirme**; v16 için kurduğun `tavla-database` bağlantısı geçerlidir. `NODE_ENV=production` ayarlı kalsın. Veritabanını yeniden oluşturma.
4. Render Build Command: `npm ci`, Start Command: `npm start`, Health Check Path: `/health`.
5. Deploy'dan sonra `https://backgammon-site.onrender.com/health` adresinde `ok: true`, `version: v17`, `storage: postgres` görünmeli. Eski sürümün maçlarını/profillerini kontrol et.

## v17 canlı kontrol listesi

- [ ] İki ayrı tarayıcıda **iki farklı kayıtlı hesap** ile giriş yap.
- [ ] A hesabından B'yi ara, arkadaşlık isteği gönder; B'de *Gelen istekler* görünmeli.
- [ ] B isteği kabul etsin. Her iki hesapta *Arkadaşlarım* ve çevrimiçi durumu görülsün.
- [ ] A, B'nin profilini ve galibiyet istatistiğini açabilsin.
- [ ] A, B'ye **Davet et** desin. A'nın adına özel oda açılsın; B daveti kabul edip aynı odaya oyuncu olarak katılsın.
- [ ] B daveti reddettiğinde otomatik katılma olmasın. Oda kapatılınca eski davet yok olsun.
- [ ] Farklı bir C hesabı, A-B arasındaki arkadaşlık isteğini kabul edemesin ve yalnızca arkadaşlara açık profili göremesin.
- [ ] B oturumdan çıkış yaptığında A'daki çevrimiçi işareti güncellensin.
- [ ] İki hesapla arkadaşlığı kabul ettikten sonra Render'ı yeniden başlat. Arkadaşlık kalıcı biçimde listelenmeli; geçici oyun davetleri yeniden görünmemeli.
- [ ] Mobilde arkadaş listesi, gelen istekler ve düğmelerin taşmadığını kontrol et.
- [ ] Eski misafir oda açma, maç, seyirci, 2x ve maç geçmişi özelliklerini tekrar dene.

## Önemli notlar

- Render'da **aynı PostgreSQL veritabanını kullan**. Ücretsiz PostgreSQL örneği **7 Aralık 2026'da sona eriyor** (kendi Render ekranındaki tarih). O zamandan önce kalıcı çözüm/yedek planla.
- `DATABASE_URL` bağlantısını, şifreleri veya `tavla_session` çerezini GitHub'a yükleme, ekran görüntüsüyle paylaşma.
- Arkadaşlar ve kullanıcılar tek `tavla_snapshots` JSONB kaydında tutuluyor; yüksek trafikte ayrı tablolar ve çok sunuculu mimari gerekecektir.
- Otomatik testler simüle edilmiş sistemde **66/66 başarılı**; gerçek Render iki hesapla uçtan uca davet testi yayın sonrası yapılmalı.
