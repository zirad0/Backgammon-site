# v19.1 Türkçe kullanıcı adı düzeltmesi

Bu paket v19 üzerine hesap kayıt ekranı ve sunucuda Türkçe kullanıcı adı desteği ekler. Mevcut `DATABASE_URL` ve `ADMIN_USER_ID` ayarlarını **değiştirme**. Veritabanı yapısı veya ek bağımlılık değişmedi.

Yayınlamak için ZIP içindeki dosyaları mevcut GitHub deposundaki dosyalarla değiştirip Render'da son dağıtımı bekle. Tarayıcıda eski arayüz önbellekte kalırsa sert yenile (Ctrl+F5). Test için `Aybüke`, `Çağla`, `İpek` gibi kullanıcı adlarıyla kayıt oluşturup giriş yap.

---

# Tavla Online v19 — Render ve GitHub'a yayınlama

## Mevcut v17 sitesini güncelleme

1. **Mevcut PostgreSQL veritabanının yedeğini al.** v18 ilk açılışta v17 kayıtlarını okuyup yeni `activity` alanını boş olarak başlatır; hesap, arkadaşlar, oturum, oda ve maç geçmişi korunmalıdır. Yine de üretim verisinde değişiklik öncesinde yedek önemlidir.
2. ZIP içindeki `client/`, `server/`, `tests/`, `package.json`, `package-lock.json`, `.env.example`, `render.yaml`, `README.md` ve `YAYINLAMA-REHBERI.md` dosyalarını mevcut **Backgammon-site GitHub deponun köküne** yükle, eskilerini değiştir ve commit oluştur.
3. Render web servisinin Environment bölümündeki **`DATABASE_URL` değişkenini değiştirme**; v17 için kullandığın `tavla-database` bağlantısı geçerlidir. `NODE_ENV=production` ayarlı kalsın. Veritabanını yeniden oluşturma.
4. Render Build Command: `npm ci`, Start Command: `npm start`, Health Check Path: `/health`.
5. Deploy'dan sonra `https://backgammon-site.onrender.com/health` adresinde `ok: true`, `version: v19`, `storage: postgres` görünmeli. Eski sürümün maçlarını/profillerini kontrol et.

## v18 canlı kontrol listesi

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
- Otomatik testler simüle edilmiş sistemde otomatik olarak geçiyor; gerçek Render iki hesapla uçtan uca davet testi yayın sonrası yapılmalı.


## v18: yalnızca yöneticiye özel etkinlik ekranı

1. Kendi **kayıtlı hesabına** giriş yap. Profil kartındaki **Hesap kimliğin** alanından UUID'ni kopyala.
2. Render → Backgammon-site → **Environment** bölümüne `ADMIN_USER_ID` adıyla yeni bir değişken ekle. Değer olarak **kendi UUID kimliğini** yapıştır; kaydet ve dağıtımı tamamla.
3. Siteyi yenile; yalnızca kendi hesabında **⚙ Yönetim Paneli** bağlantısı görünmeli. `/yonetim` adresini aç.
4. Başka bir hesap ve misafir pencereyle `/yonetim` adresinin engellendiğini kontrol et. Özel istatistik API'si `/api/admin/overview` de yetkisiz erişime kapalıdır.
5. İki kişiyle oda aç ve maç yap; panelde **oynayan kişi 2**, **devam eden maç 1** görünmeli. Üçüncü tarayıcı izleyici olursa **izleyici 1** görünmeli.
6. Sitede giriş, oda açma, katılma ve maç bitme saatlerini panelde filtreleyerek doğrula. Veritabanı açıkken sunucuyu yeniden başlat ve son etkinliklerin korunduğunu kontrol et.
7. **Yeni PostgreSQL veya ek tablo gerekmiyor**; mevcut `DATABASE_URL` kullanılacak. Hesap kimliğini veya bağlantı şifresini herkese açık depoya ekleme.

**Ölçüm sınırı:** Tek kişinin birden çok sekmesi aktif bağlantı sayısını artırır. Hesapsız ziyaretçinin gerçek kimliği bilinmez, odaya isimle katıldığında görünür. Günlük 30 gün / 1200 olayla sınırlıdır. Free PostgreSQL kullanım bitişini kontrol et.


## v19 — İki oyuncuyla doğrulama

- [ ] İki tarayıcıyla maça gir; **2x teklifini reddet**. Teklif edene tam **1 puan** yazılmalı, yeni el onunla başlamalı ve iki ekranda sonuç penceresi görünmeli.
- [ ] Ayrı elde **2x kabul et**. Mevcut elin devam ettiğini, tekrar 2x butonunun pasif olduğunu ve normal galibiyette **2**, marsta **4** puan yazıldığını kontrol et.
- [ ] Her oyuncu sırasında **SIRA SENDE** görselini, oyuncu kartındaki vurguyu ve açık/kapalı ses tercihini kontrol et.
- [ ] Bir oyuncu **Odadan Çık** desin. Diğer oyuncunun ana menüye dönüp **Rakibin Odadan Ayrıldı** penceresini görmesi gerekir.
- [ ] Geçici bağlantı kopmasında oda hemen kapatılmamalı; önceki bağlantı kurtarma süresi sürmeli.
- [ ] Yönetici paneli ve seyirci modu eski sürümdeki gibi çalışmalı.

Yeni veritabanı veya `DATABASE_URL` değişikliği gerekli değildir; mevcut PostgreSQL ve `ADMIN_USER_ID` ayarlarını koru. Dağıtımdan önce mümkünse veritabanı yedeği al.
