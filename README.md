# Tavla Online v17 — Arkadaşlık Sistemi

Node.js 20+, Express, Socket.IO ve PostgreSQL ile iki kişilik online tavla. **v16'daki oyun, spectator, responsive, profil, hesap, maç geçmişi, bağlantı kurtarma, public/private oda ve hile kontrolü özellikleri korunur.**

## Yeni: Arkadaşlar ve oyun davetleri

Kayıtlı hesapla oturum açınca ana menüde **Arkadaşlar ve davetler** bölümü görünür:

- **Kullanıcı arama:** Kullanıcı adının en az 2 harfiyle arama; en çok 10 eşleşme. Kendin sonuçlarda görünmezsin.
- **Arkadaşlık isteği:** Gönderme, gelen isteği kabul veya reddetme, bekleyen isteği iptal etme, arkadaşlıktan çıkarma.
- **Çevrimiçi durum:** Kullanıcının geçerli oturumlu aktif Socket.IO bağlantılarına göre anlık çevrimiçi/çevrimdışı işareti.
- **Profil:** Arkadaşın istatistiklerini ve son maç skorlarını görebilme; diğer oyuncuların hesabıyla izinsiz erişim yok.
- **Oyun daveti:** Çevrimiçi arkadaşını davet et; oda sahibi henüz rakip bekliyorsa o odaya davet gider. Açık odan yoksa sistem senin adına **özel, seyirciye kapalı** bir oda açar. Arkadaşın daveti kabul ederek odaya katılır; ret de mümkündür.
- **Arkadaş maçını izleme:** Arkadaşın seyirci izni açık aktif maç yapıyorsa arkadaş kartındaki “İzle” düğmesiyle izleyebilirsin. Özel maçlar genel listede gösterilmez.
- **Kalıcı arkadaşlık:** İstekler ve onaylanmış arkadaşlıklar v16'yla uyumlu PostgreSQL snapshot kaydının `friends` alanında saklanır. Ek tablo/migrasyon gerektirmez.
- **Davet süresi:** Davetler 5 dakika geçerlidir, sunucu yeniden başlatıldığında sıfırlanır. Oda kapanırsa veya rakip katılırsa eski davetler geçersiz olur.

Misafirler eskisi gibi oda açıp maç yapabilir; arkadaşlık işlemleri için hesap açmak gerekir.

## Çalıştırma

```bash
npm ci
npm test
npm start
```

`http://localhost:3000` — `/health` yanıtında `version: "v17"` beklenir.

**Üretimde `DATABASE_URL` zorunludur.** Render → Backgammon-site → Environment'da önceden tanımladığın PostgreSQL bağlantısı v17 için de kullanılır. Yerel geliştirmede URL olmadan JSON dosyası kullanılabilir ama üretimde geçici dosya modu kullanılmaz.

## Güvenlik ve sınırlar

- Arkadaşlık işlemlerinde gönderici hesabı **Socket.IO bağlantısının sunucu tarafından doğrulanmış HttpOnly oturum çerezinden** alınır; istemci başka hesap adına istek kabul edemez.
- Arkadaş profilleri yalnızca onaylı arkadaşlara açıktır. Şifre özetleri, oturum tokenları ve diğer gizli alanlar yanıtlarla gönderilmez.
- Arkadaşlık ve oyun davetleri için istek sınırlamaları ve kapasite kontrolleri vardır. Gerçek kullanıcı sayısı artarsa IP + hesap bazlı dağıtık hız sınırlama, engelleme/şikâyet ve moderasyon gereklidir.
- **Tek Node instance / tek snapshot JSONB** tasarımı korunur; çoklu Render instance desteği yoktur. Önemli hesaplar için düzenli PostgreSQL yedeği alın.
- E-posta doğrulama, parola sıfırlama ve kullanıcı engelleme sistemi henüz yoktur.
- Arkadaş daveti **iki tarafı otomatik eşleştirmez**; davet alanın kabul etmesi gerekir. Oyun odası dolarsa veya kapanırsa davet geçersiz olur.
- Postgres Free planındaki mevcut veritabanının bitiş tarihini Render panelinden takip et. Süresi dolarsa arkadaşlıklar ve hesaplar dahil kayıtlar kaybolabilir.

## Test

`npm test` toplam **66 otomatik test** çalıştırır. Bunlar eski sürümün 56 testiyle birlikte arkadaşlık yetkilendirmesi, arama, istek, onay, ret, silme, veritabanı snapshot'ından geri dönüş, davet, oda kapanınca davetin silinmesi ve çevrimiçi durumunu kapsar. Testler HTTP, Socket.IO ve PostgreSQL simülasyonlarıyla çalışır. **Gerçek Render veritabanı ve iki ayrı hesapla canlı davet akışı henüz doğrulanmadı.**

## Yayınlama

`YAYINLAMA-REHBERI.md` dosyasını izle. Mevcut Render `DATABASE_URL` bağlantısını yeni bir veritabanı kurmadan kullanabilirsin. Gerçek gizli bilgileri ZIP dosyasına veya GitHub'a koyma.

**Yapımcı:** Zirad — https://buymeacoffee.com/zirad — https://discord.com/users/476723789221199872
