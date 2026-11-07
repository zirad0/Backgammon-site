# Tavla Online v16 — GitHub / Render Yayın Rehberi

## A) v15’ten v16’ya geçiş

1. Var olan Render web hizmetinin **PostgreSQL `DATABASE_URL`** değeriyle çalıştığından emin ol. Gerekirse Render → Web Service → Environment üzerinden oluşturduğun PostgreSQL'in Internal Database URL bağlantısını ekle. Bu değeri GitHub'a veya sohbetlere kopyalama.
2. Önemli oyun verileri varsa önce PostgreSQL **yedeklemesi** yap. v16 mevcut v15 kayıt biçimini korur ve odalara `allowSpectators` alanı ekler. Eski odalar izlemeye kapalı açılır.
3. ZIP'in içindeki `client/`, `server/`, `tests/`, `package.json`, `package-lock.json`, `render.yaml`, `.env.example`, `README.md` ve bu rehberi GitHub deponun kök dizininde eskileri değiştirerek yükle.
4. Render ayarlarında Build Command `npm ci`, Start Command `npm start`, Health Check Path `/health`, `NODE_ENV=production`, `DATABASE_URL=<gizli PostgreSQL URL>` olmalı.
5. Otomatik deploy açıksa GitHub commit'inden sonra dağıtılır. Değilse Render → Manual Deploy → Deploy latest commit.
6. `/health` yanıtında `ok: true`, `version: v16`, `storage: postgres` kontrol et. Render loglarında `postgres_connected` ve `server_listening` arayabilirsin.

## B) Seyirci modu kabul testi

- [ ] Herkese açık + izleyici izni **kapalı** oda oluştur: rakip gelince maç seyirci listesinde **görünmez**; kodla izleme de reddedilir.
- [ ] Herkese açık + izleyici izni **açık** oda oluştur: ikinci oyuncu katılana kadar yalnızca bekleyen oda listesinde görünür; maç başlayınca bekleyenlerden kalkar ve "İzlenebilir canlı maçlar" listesine geçer.
- [ ] Üçüncü ayrı tarayıcı/sekmede "İzle"ye bas: oyuncuların adları, skor, zar ve taşlar anlık güncellenir; hamle/2x/sohbet/rövanş butonları yoktur. Sunucudan sahte `move:play`, `dice:roll` vs. gönderildiğinde de işlem yapılmaz.
- [ ] Özel + izleyici izni **açık** oda oluştur: özel maç herkesin listesinden gizlidir; yalnızca doğru oda koduyla izlenebilir.
- [ ] Seyirci "İzlemeyi Bırak" seçince iki oyuncunun oyunu devam eder ve sayaç azalır; seyirci yenileyince ya da ağ koptuğunda tekrar bağlanabilir.
- [ ] Oda kapatılırsa seyirci ana sayfaya döner; maç kazanılırsa seyirci listeden kaldırılır.
- [ ] Oda sahibi izleyici izni açıkken sunucu/Render yeniden başlatılırsa izin kaybolmaz. Seyirciler bağlantı yenilendiğinde geri döner.
- [ ] Gerçek telefon genişliklerinde (ör. 320, 375, 430 px), tablette, masaüstünde görsel test yap.

## C) Diğer yayın öncesi kabul testleri

- [ ] Mobil ve masaüstünde misafir olarak oda oluşturuluyor/katılınıyor.
- [ ] Aynı kullanıcı adı ile iki kez kayıt olunamıyor; yanlış şifre reddediliyor.
- [ ] İki farklı tarayıcıda farklı hesaplarla giriş yapılabiliyor; isimler odada doğru görünüyor.
- [ ] Başka bir misafir kayıtlı oyuncunun adını kullanamıyor.
- [ ] Kayıtlı oyuncu başka bir cihazla aynı hesabına girip açık maçına yeniden bağlanıyor; eski bağlantı devreden çıkıyor.
- [ ] Maç tamamlandığında kazanana bir galibiyet, kaybedene bir mağlubiyet yazılıyor.
- [ ] Maç geçmişi hesapla başka bir tarayıcıda giriş yapınca görünüyor.
- [ ] Çıkış yapınca profil gizleniyor ve misafir olarak oynanabiliyor.
- [ ] Render sunucusu yeniden başlatıldığında hesaplar, oturumlar, maç geçmişi ve aktif odalar PostgreSQL'den geri geliyor.
- [ ] `DATABASE_URL` bozulduğunda sağlık kontrolü 503 veriyor; sistem kalıcı kayıt varmış gibi davranmıyor.

## D) Önemli güvenlik ve operasyon notları

- Gerçek şifreleri kullanıcıdan asla isteme ve hiçbir şifreyi, `tavla_session` çerezini veya `DATABASE_URL` değerini hata kayıtlarına/görsel ekran görüntülerine koyma.
- `NODE_ENV=production` ayarında oturum çerezi `Secure; HttpOnly; SameSite=Strict` olur. Siteni **HTTPS** üzerinden yayınla.
- Parola sıfırlama, e-posta doğrulama, Google/Discord sosyal giriş ve hesap silme paneli bu sürümde bulunmuyor; herkese açık büyük kullanıcı kitlesi hedefliyorsan önce ekle.
- Şifreler `scrypt` ile özetlenmiştir fakat DB tek büyük JSONB belgesi kullandığı için ölçekli kullanıcı trafiğinde ayrı hesap/oturum tablolarına geçmek gerekir.
- Render Free PostgreSQL uzun vadede yedeksiz ve sınırlıdır; planın güncel süresi/disk koşullarını kontrol et. Yedek al; süresi dolan DB'deki hesapları ve maçları geri getiremeyebilirsin.
- Eski v14 maçları anonim oyuncu kimlikleriyle kaydedildiyse yeni hesap açınca otomatik olarak hesaba aktarılmaz.

**Test durumu:** Otomatik testler 56/56 başarılı; simüle edilmiş seyirci arayüzü çeşitli ekran genişliklerinde kontrol edildi. Gerçek Render PostgreSQL ve iki gerçek cihazla uçtan uca canlı bağlantı testi henüz yapılmadı.
