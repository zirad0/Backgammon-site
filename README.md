# Tavla Online v16 — Seyirci Modu + Hesaplar ve Profiller

Node.js 20+ / Express / Socket.IO / PostgreSQL tabanlı iki kişilik çevrimiçi tavla. v14'teki mobil/4K düzeni, herkese açık ve özel odalar, 2x teklifleri, sohbet, rövanş, sunucu doğrulamalı zar ve hamleler, 15 dakikalık geri bağlanma ve PostgreSQL kayıt altyapısı korunur.

## v16 yenilikleri — Canlı maç izleme

- **Oda oluştururken izin:** "👁 İzleyicilere izin ver" kutusu varsayılan olarak **kapalıdır**. Oda herkese açık ya da özel olabilir; seyirci izni ayrıca seçilir.
- **Canlı maç listesi:** Ana menüdeki **İzlenebilir canlı maçlar** bölümünde yalnızca oyun başlamış, herkese açık **ve** izleme izni açık maçlar görünür. Oyuncu adları, skor, hedef puan ve anlık seyirci sayısı gösterilir. Kazanılan maçlar listeden kalkar. Normal oda listesi eskisi gibi yalnızca rakip bekleyen odaları gösterir.
- **Özel oda izleme:** İzleme izni açık özel maçlar **hiçbir zaman listelenmez**. Kod sahibi kişiler "Oda Koduyla Maçı İzle" düğmesiyle izleyebilir.
- **Salt-okunur:** Oyuncu rolünden ayrı `viewer:watch` / `viewer:leave` işlemleri kullanılır. İzleyici zar atamaz, taş oynatamaz, hamle onaylayamaz, 2x, rövanş, sohbet veya odayı kapatma işlemi yapamaz. Yetkiler **sunucu tarafından** kontrol edilir.
- **Gizlilik:** Seyirciler canlı tahta, zar animasyonları, skorlar ve oyuncu adlarını görür; özel oyun sohbetini veya geçerli hamle listelerini almaz.
- **Bağlantı kurtarma:** İzleyici internet bağlantısı kesilince açık maçı tekrar izlemeye bağlanır. İzleyicinin çıkışı **oyunu kapatmaz**. Oda kapanırsa izleyiciler bilgilendirilir.
- **Sınır:** Her odada en fazla **60 eşzamanlı seyirci** bulunabilir. Bu sürümde yayın gecikmesi/geriye sarma yok; yalnızca canlı görüntü vardır.
- **Veri uyumluluğu:** v15 PostgreSQL kayıt biçimi korunur; `allowSpectators` alanı eklenir. Eski odalar güvenli varsayılan olarak izlemeye kapalıdır. Seyirci oturumları kalıcı kayda yazılmaz, yeniden bağlanarak izlemeye devam eder.

## v15 yenilikleri

- **Ücretsiz kayıt ve giriş:** 3–20 karakterlik, İngilizce harf/rakam/alt çizgi içeren kullanıcı adı ve en az 8 karakterlik şifre. Kullanıcı adları büyük/küçük harfe duyarsız şekilde benzersizdir.
- **Misafir olarak oynama:** Kayıt/giriş zorunlu değil; önceki oda kurma ve katılma akışları devam eder.
- **Profil:** Hesap adı, tamamlanan maç sayısı, galibiyet, mağlubiyet ve galibiyet yüzdesi. Geçmiş maçlar hesap kimliğiyle saklandığı için aynı hesaba başka cihazdan girince yeniden görünür.
- **Kayıtlı isim koruması:** Misafir oyuncu, kayıtlı kullanıcı adını kullanamaz. Hesaplı oyuncunun oda içindeki adını yalnızca sunucu belirler; tarayıcıdan sahte ad gönderilemez.
- **Bağlantı kurtarma:** Kayıtlı oyuncular yeni bir cihazda veya yeni sekmede aynı hesaba giriş yapıp bağlı oldukları açık maça geri dönebilir. Misafirler mevcut gizli sekme tokenına ihtiyaç duyar.
- **Güvenlik:** Şifreler rastgele tuz ile `crypto.scrypt` üzerinden türetilmiş özetle tutulur. Oturum tokenları kriptografik rastgele üretilir, sunucuda sadece SHA-256 özeti kaydedilir. Tarayıcıya `HttpOnly; Secure` (üretimde); `SameSite=Strict` çerezi verilir. JSON/same-origin kontrolü ve temel giriş denemesi sınırlaması uygulanır.
- **v14 uyumluluğu:** PostgreSQL `tavla_snapshots` JSONB kaydının mevcut biçimi korunur; `users` ve `sessions` alanları eklenir. v14'ün mevcut odaları ve maç geçmişi yeni sürüme taşınır. Hesap açılmadan önceki eski **misafir** maçları otomatik olarak yeni hesapla birleştirilmez.

## Çalıştırma

```bash
npm ci
npm test
npm start
```

Site: `http://localhost:3000` · Sağlık kontrolü: `http://localhost:3000/health` (`version: v16`).

Yerelde `DATABASE_URL` olmadan `data/matches.json` kullanılır; kullanıcılar dahil tüm kayıtlar **yalnızca bu yerel dosyaya** kaydedilir. Üretimde `DATABASE_URL` zorunludur; güvenilir kalıcılık için Render'da PostgreSQL veya uyumlu kalıcı DB gerekir. DB bağlantısı yoksa üretim sunucusu bilerek başlamaz.

### API

- `POST /api/auth/register` — JSON `{ "username": "...", "password": "..." }`; kayıt + oturum çerezi.
- `POST /api/auth/login` — JSON kullanıcı adı/şifre; yeni oturum çerezi.
- `POST /api/auth/logout` — JSON `{}`; mevcut oturumu iptal eder.
- `GET /api/me` — giriş yapılmışsa kullanıcı/profil/son maçlar, değilse `{ "authenticated": false }`.

Hassas tokenlar kullanıcıya JSON ile gönderilmez. API yalnızca aynı origin'den JSON giriş kabul eder. Tarayıcıda `fetch` ile `credentials: 'same-origin'` kullanılır.

### Bilinen sınırlar

- Bu sürüm **kullanıcı adı + şifre** ile giriş sunar; Google/Discord OAuth, e-posta doğrulaması ve parola kurtarma henüz eklenmemiştir. Parolanı unutursan otomatik sıfırlama yoktur. Gerçek kitleye açmadan önce kurtarma ve kötüye kullanım önlemleri geliştirilmelidir.
- Misafir olarak oynadığın eski maçların kayıtlı kullanıcı hesabına taşınması otomatik yapılmaz. Yalnızca oturum açtıktan sonraki maçlar profil istatistiğine bağlanır.
- İstatistiklerde yalnızca `finished` maçlar galibiyet/mağlubiyet olarak sayılır; `interrupted` maçlar son maç geçmişinde görülebilir ama kazanma oranına girmez.
- v14 gibi **tek Node süreci/tek web örneği** ve tek JSONB snapshot yapısına dayanır. Çok oyunculu ölçeklenme için ayrı `users`, `sessions`, `matches` tabloları, daha gelişmiş giriş sınırlaması, e-posta/parola kurtarma, düzenli yedekler ve dağıtık oda yönetimi gerekir.
- Sunucu yanıtlarında şifre/oturum verisi ve gizli oyuncu tokenları döndürülmez. Buna karşın kullanıcı hesaplarının bulunduğu PostgreSQL yedeği hassastır; yayınlamayın.
- Ücretsiz Render PostgreSQL'in kullanım süresi ve yedek koşulları planına bağlıdır. Kalıcı veriyi güvenceye almak için hesabının güncel Render koşullarını kontrol et ve harici yedekleme kur.

## Test notu

`npm test` **56 test** içerir: v14 oyun/bağlantı/kayıt testleri + hesap özeti ve oturum güvenliği + HTTP register/login/logout + hesapla oda adını doğrulama + farklı cihazdan maça dönme + profil galibiyet/mağlubiyet kaydı. Sunucu testleri sahte Socket.IO/HTTP/DB ortamını kullanır. Ayrıca 180/375/768/1440 piksel genişliklerde **simüle edilmiş** seyirci arayüzü tarayıcıda kontrol edildi. Gerçek Render DB ve iki farklı gerçek cihazla uçtan uca test **henüz tamamlanmadı**. Bu ortamda `npm ci` çevrimdışı paket eksikliği nedeniyle tamamlanamadı; Render ağ bağlantısıyla gerekli paketleri kurmalıdır.

## Yayınlama

`YAYINLAMA-REHBERI.md` dosyasındaki yönergeleri izle. `DATABASE_URL` veya gerçek şifreleri GitHub'a koyma. Önce PostgreSQL'i bağla, ardından v16 ZIP içindeki dosyaları GitHub depoya yükle ve deploy et.

**Zirad bağlantıları:** `buymeacoffee.com/zirad`, `discord.com/users/476723789221199872`.
