# Tavla Online v13 — GitHub + Render Dağıtımı ve Kalıcı Kayıt

## GitHub'a güncelleme

1. ZIP'i bilgisayarına indirip aç.
2. GitHub'daki `Backgammon-site` deponun **köküne** `client/`, `server/`, `tests/`, `package.json`, `package-lock.json`, `render.yaml`, `README.md` ve bu rehberi yükle / mevcut dosyaların üzerine yaz.
3. Yeni `server/storage.js` ve `tests/storage.test.js` dosyalarının da depoya eklendiğini kontrol et.
4. GitHub'da **Commit changes** işlemini yap. Render otomatik dağıtım açıksa değişiklikler yayınlanır; değilse **Manual Deploy > Deploy latest commit**.
5. `node_modules/`, `data/`, `matches.json`, oyuncu tokenları, `.env` dosyaları ve gerçek kayıtları GitHub'a yükleme.

## Web servisi ayarları

- **Runtime:** Node
- **Build:** `npm ci`
- **Start:** `npm start`
- **Health:** `/health`
- **Port:** Render'ın sağladığı `PORT` (kod otomatik okur)
- **Instance:** Tek örnek / tek Node süreci

## Render'da maç kayıtlarını gerçekten kalıcı tutmak

### Seçenek A — Tek sunucu için Persistent Disk (bu sürümde kod desteği var)

1. Render hesabında **persistent disk destekleyen** bir servis planına geç; ücretsiz web servisinde bu özellik kullanılamayabilir / bulunmaz.
2. Web Service → **Disks** bölümünden örneğin `/var/data` konumuna disk bağla.
3. Web Service → **Environment** bölümüne `TAVLA_DATA_FILE` değeri olarak `/var/data/matches.json` ekle.
4. Yeni dağıtımdan sonra bir oyun başlat ve sunucuyu yeniden başlatıp aynı sekmelerle maça geri dönmeyi dene.
5. Disk veri içereceğinden erişim ve yedekleme politikası uygula. Tek bir yerel JSON dosyası, yüksek eşzamanlı kullanım için veritabanının yerini tutmaz.

### Seçenek B — Render ücretsiz servis (geçici kayıt)

Hiçbir ayar yapmazsan `data/matches.json` dosyasına kayıt yapılır ama **Render yeniden dağıtıldığında veya yeniden oluşturulduğunda veri silinebilir**. Ücretsiz planda gerçek kalıcılık **yoktur**. İleride PostgreSQL gibi bir dış veritabanına geçilebilir fakat **bu ZIP bunu henüz desteklemez**.

## Yayın sonrası manuel kontrol

- [ ] İki ayrı tarayıcıdan özel oda aç/katıl, geçerli hamle yap.
- [ ] Herkese açık oda beklerken listede; ikinci kişi girince listede değil.
- [ ] Maç sırasında bir oyuncuda interneti kes, diğer oyuncu “duraklatıldı” durumunu görsün.
- [ ] Aynı sekme tekrar bağlandığında tahtanın, zarların ve sıranın korunduğunu doğrula.
- [ ] Uzun süre dönmeyen oyuncuda 15 dakika sonra odanın kapandığını ve maçın yarıda kaldı olarak kaydedildiğini doğrula.
- [ ] Maç bitince ana sayfadaki “Son maçlarım” bölümünü kontrol et.
- [ ] Kalıcı disk bağladıysan sunucuyu yeniden başlat, devam eden odanın yüklendiğini doğrula.
- [ ] Farklı oyuncu anahtarıyla başka kişinin maç geçmişi görünmesin.
- [ ] Telefon görünümü, zar/2x/hamle sırası ve odadan çıkış kontrolü.

## Önemli sınırlar

- Oyuncu oturumu ve arşiv erişimi sekmeye özgü gizli anahtara bağlıdır; üyelik/hesap sistemi yoktur.
- Bir oyuncunun sekmesi tamamen kapatılırsa otomatik hesap kurtarma garanti edilmez.
- Sistem tek sunuculu ve dosya tabanlıdır. Çoklu Node örnekleri ya da yatay ölçekleme için ortak veritabanı ve Socket.IO adapter gereklidir.
- Otomatik testler üretim ağında iki gerçek cihazla yapılan uçtan uca testlerin yerine geçmez.

## v13 mobil ve ekran çözünürlüğü kontrolü

- [ ] 320×568, 375×812, 390×844, 430×932 çözünürlüklerinde oyun ekranında tahta, zarlar ve işlem butonları birbirini örtmesin.
- [ ] Telefonu yatay çevir; yatay sayfa taşması olmasın.
- [ ] **Tahtayı büyüt** düğmesine bas; yalnızca tahta alanı yatay kaydırılsın. **Ekrana sığdır** ile geri dön.
- [ ] 180 CSS pikseli gibi çok dar ekranda tahta kaydırılabilir olsun ve tüm sayfa yatay taşmasın.
- [ ] 1280, 1920, 2560 ve 3840 genişliklerinde masaüstü arayüz merkezde kalsın.
- [ ] İki gerçek cihazda aynı maçta dokunarak taş seçme ve taşıma işlemini dene (tarayıcı simülasyonu bu testi tamamıyla karşılamaz).
