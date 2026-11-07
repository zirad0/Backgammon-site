# Tavla Online v11 — GitHub ve Render yayınlama rehberi

## GitHub'a yükleme veya mevcut siteyi güncelleme

1. İndirdiğin ZIP dosyasını aç.
2. GitHub'daki ilgili depoyu aç; örneğin `Backgammon-site`.
3. **ZIP'in içindekileri** depodaki karşılık gelen dosyaların üzerine yükle: `client/`, `server/`, `tests/`, `package.json`, `package-lock.json`, `render.yaml`, `README.md` ve bu rehber.
4. Değişiklikleri `Commit changes` ile kaydet.
5. Dosyalar deponun **kök dizininde** bulunmalı; yanlışlıkla tüm dosyaları ek bir klasör içine koyma.
6. `node_modules/` klasörünü GitHub'a yükleme.

> Mevcut Render sitesi bu GitHub deposuna bağlıysa commit'ten sonra otomatik dağıtım tetiklenebilir. Otomatik dağıtım kapalıysa Render'da **Manual Deploy > Deploy latest commit** kullan.

## Render'da ilk kurulum

1. <https://dashboard.render.com/> sayfasında **New > Web Service** seç.
2. GitHub deposunu bağla ve doğru dalı (`main` vb.) seç.
3. Yapılandırma:

   | Ayar | Değer |
   | --- | --- |
   | Runtime | Node |
   | Build Command | `npm ci` |
   | Start Command | `npm start` |
   | Root Directory | Boş (depo kökü) |
   | Health Check Path | `/health` |
   | Plan | Hesabına uygun plan; ücretsiz seçenek varsa kullanılabilir |

4. Yayın tamamlandığında Render'ın verdiği `https://...onrender.com` alan adını aç.
5. Bir cihazdan oda aç, başka cihazdan davet bağlantısıyla katıl.

## Yayın öncesi kontrol listesi

- [ ] Ana sayfa telefonda ve bilgisayarda açılıyor.
- [ ] Özel oda açılınca herkese açık odalar listesinde görünmüyor; kodla katılım çalışıyor.
- [ ] Herkese açık oda oluşturulduğunda listede oyuncu adı ve puan hedefi görünüyor.
- [ ] Herkese açık oda ikinci oyuncu girince listeden anında kalkıyor.
- [ ] Mobil ekranda tahta, taş toplama alanı ve kontrol panelleri taşmıyor.
- [ ] Oda aç / davet koduyla katıl çalışıyor.
- [ ] Bir oyuncunun attığı zar diğer oyuncuda aynı görünüyor.
- [ ] Hamleleri iki oyuncu da aynı şekilde görüyor.
- [ ] Mars, 2x kabul ve 2x ret skoru doğru işliyor.
- [ ] Kazanan sonraki eli başlatıyor.
- [ ] Odadan Çık iki oyuncuyu ana sayfaya döndürüyor.
- [ ] Rövanş için iki oyuncunun da onayı gerekiyor.
- [ ] Telefonun Wi-Fi bağlantısı kesilip açıldığında aynı sekmede yeniden bağlanma deneniyor.

## Önemli sınırlar

- Render veya başka ücretsiz sağlayıcı uygulamayı boşta kaldığında uykuya alabilir; gecikme, yeniden başlatma ve kullanım kısıtları sağlayıcı planına göre değişir. Güncel şartlar için [Render belgelerini](https://render.com/docs/free) kontrol et.
- Maç bilgileri RAM'de kalır. Sunucu yeniden başlarsa oda ve skor sıfırlanır.
- Sunucu tek süreç/tek örnek üzerinde çalışacak şekilde tasarlanmıştır. Birden çok sunucu kopyası kullanılıyorsa paylaşımlı oda veri deposu ve Socket.IO adapter eklenmelidir.
- Herkese açık bir site için canlı cihaz testleri, hata kayıtları, moderasyon ve kötüye kullanım korumaları ayrıca değerlendirilmelidir.
