# Tavla oyununu ücretsiz internete koyma

Bu sürüm, **Hamachi olmadan** internet üzerinden oynanabilmesi için hazırlanmıştır.
Oyuncular yalnızca internet adresine girer, oda açar ve davet bağlantısını paylaşır.

## 1. GitHub'a yükle

1. https://github.com adresinde hesabına gir.
2. **New repository** ile yeni bir proje oluştur (örneğin `tavla-online`).
3. Bilgisayarına indirdiğin bu ZIP'i aç. **ZIP dosyasının kendisini değil, içindeki dosyaları** GitHub projesine yükle.
4. Dosyalar GitHub'da doğrudan kökte olmalı: `package.json`, `server/`, `client/`, `render.yaml` vb.
5. **node_modules klasörünü yükleme.** Bu pakette zaten bulunmuyor; Render gerekli parçaları kendisi kurar.

## 2. Render'a bağla

1. https://dashboard.render.com adresinden ücretsiz hesap aç.
2. **New > Web Service** seç.
3. GitHub hesabını bağla, `tavla-online` projesini seç.
4. Ayarlar:
   - **Language / Runtime:** Node
   - **Branch:** main (GitHub'daki ana dalın adı neyse)
   - **Root Directory:** boş
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Instance Type / Plan:** **Free**
5. **Deploy Web Service** düğmesine bas.
6. İşlem tamamlandığında sana `https://...onrender.com` biçiminde bir adres verilecek.

## 3. Arkadaşınla dene

- Bu adrese gir, **Oda Oluştur** düğmesine tıkla.
- Oda bağlantısını arkadaşına gönder.
- Arkadaşın bağlantıya girip aynı odaya katılsın.
- Bilgisayarını kapatman oyunu kapatmaz. Ancak Render'ın ücretsiz hizmeti bir süre boş kalınca uykuya geçer.

## Bilmen gereken sınırlar

- Render ücretsiz sunucuyu 15 dakika etkinlik olmadan uykuya alabilir; ilk açılış yaklaşık bir dakika sürebilir.
- Devam eden aktif WebSocket mesajları, boşta kalma süresini sıfırlar.
- **Oda ve maç bilgileri yalnızca geçici hafızada tutulur.** Sunucu yeniden başlarsa maç ve odalar kaybolur.
- Bu bir ilk sürümdür. Kalıcı maç kayıtları, hesaplar, moderasyon, kapsamlı yük testi henüz yoktur.
- Ücretsiz hizmetlerin kullanım ve süre sınırları bulunur.

## Yerelde çalıştırma (isteğe bağlı)

Bilgisayarda Node.js yüklüyse proje klasöründe `npm ci` ve ardından `npm start` komutlarını çalıştır. `http://localhost:3000` adresini aç.

## Güncel resmi bilgiler

- https://render.com/docs/deploy-node-express-app
- https://render.com/docs/free
