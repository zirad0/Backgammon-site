# Tavla Online v19.1 — Türkçe Kullanıcı Adı Düzeltmesi

Node.js 20+, Express, Socket.IO ve PostgreSQL ile iki kişilik online tavla. **v17'deki oyun, spectator, responsive, profil, hesap, maç geçmişi, bağlantı kurtarma, public/private oda ve hile kontrolü özellikleri korunur.**

## v19.1 düzeltmesi — Türkçe karakterli kullanıcı adları

- Hesap kayıt ve giriş alanları **Aybüke, Çağla, Şule, Yiğit, İpek** gibi kullanıcı adlarını kabul eder.
- İstemci ve sunucuda aynı 3–20 karakter doğrulaması uygulanır; şifre kuralları değiştirilmedi.
- Normalizasyon ve büyük/küçük harf kontrolü sayesinde eşdeğer isimlerle ikinci hesap açılamaz.
- Mevcut hesaplar, arkadaşlıklar ve PostgreSQL verileri korunur. Yeni veritabanı gerekmez.
- Yayın sonrası iki cihazda hesap açma ve giriş akışını kontrol et.

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

`http://localhost:3000` — `/health` yanıtında `version: "v19"` beklenir.

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

`npm test` otomatik testleri çalıştırır. Bunlar eski sürümün 56 testiyle birlikte arkadaşlık yetkilendirmesi, arama, istek, onay, ret, silme, veritabanı snapshot'ından geri dönüş, davet, oda kapanınca davetin silinmesi ve çevrimiçi durumunu kapsar. Testler HTTP, Socket.IO ve PostgreSQL simülasyonlarıyla çalışır. **Gerçek Render veritabanı ve iki ayrı hesapla canlı davet akışı henüz doğrulanmadı.**

## Yayınlama

`YAYINLAMA-REHBERI.md` dosyasını izle. Mevcut Render `DATABASE_URL` bağlantısını yeni bir veritabanı kurmadan kullanabilirsin. Gerçek gizli bilgileri ZIP dosyasına veya GitHub'a koyma.

**Yapımcı:** Zirad — https://buymeacoffee.com/zirad — https://discord.com/users/476723789221199872


## Yeni: yalnızca yöneticiye özel canlı yönetim paneli

- Panel adresi: **`/yonetim`** (ör. `https://backgammon-site.onrender.com/yonetim`).
- **Aktif bağlantılar:** hesaplı kullanıcı adı veya anonim misafir, ilk bağlanma zamanı, rolü (oyuncu/seyirci/ziyaretçi), oda kodu.
- **Canlı metrikler:** aktif tarayıcı bağlantısı, bağlı oyuncu, devam eden maç, izleyici, bekleyen oda ve arşivlenen maç.
- **Oda görünümü:** özel odalar yalnızca yöneticiye görünür; skor, bağlantı durumu ve izleyici sayısı.
- **Etkinlik geçmişi:** giriş/kayıt/çıkış, odaya giriş/çıkış, maç başlama/bitme, bağlantı kurtarma ve seyirci girişleri. Filtreleme ve arama var. Her 15 saniyede otomatik güncellenir.
- **Kalıcı günlük:** mevcut PostgreSQL snapshot'a `activity` alanı olarak yazılır; **en fazla 1200 olay / 30 gün** saklanır. Eski snapshot ile geriye uyumludur.

### Yönetici hesabını açmak için (bir kere)

1. Sitede kendi kayıtlı hesabınla giriş yap. Yoksa önce kayıt ol.
2. Ana menüde **Oyuncu Profilin → Hesap kimliğin → Kopyala** ile kendi UUID kimliğini kopyala. Bu bir şifre değildir; yine de gereksiz yere paylaşma.
3. Render → **Backgammon-site → Environment → Add Environment Variable** kısmında `ADMIN_USER_ID` anahtarına kopyaladığın UUID değerini yaz; **Save, Deploy**.
4. Kendi hesabınla tekrar giriş yapıp sayfayı yenilediğinde **⚙ Yönetim Paneli** bağlantısı görünür. Doğrudan `/yonetim` adresine de girebilirsin.
5. **Yöneticiye yetki vermek için kullanıcı adı değil, hesap UUID'si kullanılır.** `ADMIN_USER_ID` boşsa hiç kimse yönetici olamaz; misafirler ve diğer hesaplar API'den **401/403** alır.

### Ölçüm ve gizlilik sınırları

- Ziyaretçi sayısı aynı kişinin farklı sekmelerini ayrı bağlantılar olarak sayabilir. Hesap açmamış kişinin adını siteye giriş anında bilmek mümkün değildir; yalnızca oyuncu adıyla odaya girdiğinde isim görünür.
- **IP adresi, şifre, oturum çerezi, oyuncu anahtarı ve sohbet içeriği** yönetici günlüğüne kaydedilmez. Kayıtlar yalnızca yöneticiye açık API'den sunulur (`/api/admin/overview`, sunucuda kimlik ve yetki kontrolü).
- Bu uygulama tek Render instance için tasarlandı. Birden çok instance açılırsa çevrimiçi sayımları birleşmez; yüksek trafikte merkezi analitik/depolama gerekir.
- Yeni bir veritabanı kurmaya gerek yoktur. Mevcut `DATABASE_URL` ayarı korunur. Free PostgreSQL son kullanım tarihi Render panelinden takip edilmelidir.


## v19 — Oyun bildirimleri ve 2x puanlama

- **2x teklifinin reddi:** Teklifi gönderen **1 puan** alır; yeni eli teklifi gönderen başlatır. Sonuç penceresi her iki oyuncuya gösterilir.
- **2x kabulü:** Aynı el devam eder. Normal galibiyet **2 puan**, mars **4 puan** kazandırır; aynı elde yeniden 2x teklif edilemez. İki oyuncu da sonucu açıklayan pencere görür.
- **Odadan çıkış:** Bir oyuncu odadan çıkarsa rakip ana menüye döner, nedeni bildiren **Rakibin Odadan Ayrıldı** penceresi gösterilir. İzleyicilere de maçın kapandığı bildirilir. Bağlantının kısa süreli kesilmesi, oyundan çıkmakla aynı değildir; geri bağlanma süresi korunur.
- **Sıra uyarısı:** Aktif oyuncuya yeşil banner, vurgulu oyuncu kartı ve kısa iki notalı ses. Ses oyun sırasında **Sıra sesi** kontrolüyle kapatılabilir. Tarayıcı ses iznini engellerse görsel uyarı çalışmaya devam eder.
- Sonuç ve bilgilendirme pencereleri üst üste binmemesi için sıralanır.
- Mevcut hesap, arkadaşlık, yönetim paneli, PostgreSQL ve seyirci özellikleri korunur.
