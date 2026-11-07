# Tavla Online v13 — Akışkan Mobil Arayüz, Bağlantı Kurtarma ve Maç Kayıtları

Arkadaşlarınla gerçek zamanlı tavla oynayabileceğin Node.js + Express + Socket.IO projesi. Eski v11'in mobil arayüzü, özel/herkese açık oda listesi, 2x teklifleri, sohbet, maç ve rövanş kuralları korunur.

## v13: responsive arayüz güncellemesi

- **Tahta yeniden tasarlandı:** 300–860 CSS pikseli arasında taş, üçgen, bar, taş toplama alanı ve oyuncu panelleri gerçek ekran genişliğine uyum sağlar. Artık `transform: scale()` ile tüm tahtanın ve dokunma alanlarının minyatürleştirilmesi kullanılmaz.
- **Mobil büyütme modu:** Oyun ekranındaki **Tahtayı büyüt / Ekrana sığdır** düğmesi isteğe bağlı büyük görünüm açar. Büyük tahtada sadece tahta bölümü yatay kaydırılır; tüm sayfa yatay taşmaz.
- **Çok dar ekranlar:** 300 CSS pikselinin altındaki ekranlarda (180px genişlik dahil) taşların görünür ve seçilebilir kalması için yatay kaydırılabilir tahta kullanılır. Bu ekranlarda 24 noktayı aynı anda okunaklı göstermek fiziksel olarak mümkün değildir.
- **Tablet ve masaüstü:** Kontrol panelleri genişliğe göre tek/iki/üç sütuna geçer. 2K ve 4K monitörlerde ana alan merkezde ve okunabilir bir maksimum genişlikte kalır; devasa boyutlara gerilmez.
- **Oyun animasyonu:** Hareket eden taşın boyutu sabit 56px varsayımı yerine mevcut taşın görsel boyutuna uyarlanır.
- **Ana sayfa düzeltmesi:** İki kez gösterilen "Son maçlarım" alanı tekilleştirildi.

**Ekran çözünürlüğü notu:** CSS pikseli, fiziksel ekran pikseliyle her zaman aynı değildir; tarayıcı yakınlaştırması ve cihaz ölçeği dikkate alınır. Arayüzün temel kuralı ekranın **kullanılabilir CSS genişliğidir**. Telefonlarda yatay konum büyük tahta için daha rahattır.

## v12 yenilikleri

- **Kopma/yeniden bağlanma:** Oyuncunun bağlantısı kesilirse oyun otomatik duraklar. En fazla **15 dakika** içinde aynı oyuncu oturumuyla dönünce skorlar, tahta, zarlar ve sıra kaldığı yerden devam eder. Açıkta kalan taş animasyonu kesilirse hiç gerçekleşmemiş sayılır ve oyuncu hamleyi tekrar yapar. Bekleyen 2x teklifi güvenli biçimde iptal edilir.
- **Geri dönülmeyen odalar:** 15 dakikada dönemeyen oyuncunun odası kapatılır; sonuç “yarıda kaldı” olarak arşivlenir. Bu, haksız yere galibiyet/puan yazmaz.
- **Hile koruması:** Zarları yalnızca sunucu, `crypto.randomInt` ile üretir. Hamle, taş toplama, zar kullanım sırası, oyuncunun sırası, skor ve 2x koşulları sunucuda doğrulanır. İstemcinin sahte zar/hamle/skor göndermesi bir sonuç doğurmaz. Hatalı websocket veri tipleri, sık istekler ve eski oturumun oda kapatması engellenir.
- **Kalıcı dosya kayıtları:** Aktif oda, oyuncu kimlikleri, taş/zar durumları, puanlar ve sohbet atomik JSON dosyasına kaydedilir. Sunucu yeniden başlarken bu kayıt yüklenir. Bitmiş ve yarıda kalmış maçların son **1.000** sonucu arşivlenir.
- **Son maçlarım:** Ana menüde oyuncuya özel son 15 maç görüntülenir. Kayıtlara erişim tahmini zor, sekmeye özel oyuncu anahtarı ile yapılır. Hesap ve şifre sistemi yoktur.

## Kurulum

Node.js 20 veya üzeri:

```bash
npm ci
npm start
```

Tarayıcı: `http://localhost:3000`.

Testler (bağımlılıksız Node test çalıştırıcısı):

```bash
npm test
```

28 otomatik test: temel tavla/2x/rövanş/oda, bağlantı kopması, animasyon durdurma, 15 dakika, kayıtların geri yüklenmesi, arşiv, yetkisiz hamle, oturum devralma ve gerçek dosya okuma-yazma kontrolü.

## Kayıt dosyası ve Render konusu (ÖNEMLİ)

Varsayılan kayıt yeri: `data/matches.json`. Bu klasör `.gitignore` içinde tutulur. Kayıt dosyası **özel oyuncu anahtarları içerir**; GitHub'a veya `client/` klasörüne yükleme.

Farklı bir konum için `TAVLA_DATA_FILE` ortam değişkeni kullan:

```bash
TAVLA_DATA_FILE=/var/data/matches.json npm start
```

**Render ücretsiz web servisinin dosya sistemi kalıcı değildir.** Dolayısıyla bu projeyi Render ücretsiz planda çalıştırırsan *sunucu çalıştığı sürece ve geçici dosyalar silinmediği sürece* kayıtlar durur; yeniden dağıtım/yeniden oluşturma durumlarında kayıtların korunması **garanti değildir**. Gerçekten kalıcı üretim verisi için Render Persistent Disk sunan uygun bir ücretli plan ve disk bağlama **veya** paylaşımlı kalıcı veritabanına geçiş gereklidir. Bu sürümde **veritabanı entegrasyonu yoktur**. Disk yapılandırma adımları: [YAYINLAMA-REHBERI.md](YAYINLAMA-REHBERI.md).

Bu yöntem **tek sunucu süreci / tek örnek** içindir. Çoklu instance, çok yüksek trafik veya herkese açık rekabetçi turnuvalar için DB, dağıtık oturum yönetimi, ayrıntılı denetim ve yük testi eklenmelidir.

## Veri ve oyun kuralları hakkında

- Son 1.000 kayıt, sınırsız büyümeyi önlemek amacıyla sınırlandırılmıştır.
- Oynanmakta olan oda bir oyuncu “Odadan Çık” derse iki oyuncu için kapanır; yarım kalan maç son maçlara yazılır.
- Oyuncu anahtarı `sessionStorage` içinde, sekmeye özel olarak tutulur. Aynı sekmede sayfa yenilemesi veya geçici internet kesintisi sonrasında oturum dönebilir; **sekme tamamen kapanırsa** yeni sekmenin eski anahtarı otomatik olarak bulması garanti edilmez. Kayıtlı sonuçlar bu anahtara bağlıdır, kalıcı hesap sistemi değildir.
- 2x/puan sistemi mevcut uygulamanın özel Türk tavlası kurallarıdır; uluslararası doubling cube kurallarına birebir eşit değildir.
- Güvenlik kontrolleri sıradan hileleri önler, ancak bot tespiti, DDoS koruması ve dış güvenlik denetimi yapılmadığından “hile imkânsız” garantisi verilemez.

Eski sürümlerden devam eden: Her elde kazanan başlar; iki oyuncu rövanş onayı gerekir; özel oda listeye girmez; herkese açık oda sadece maç başlamadan görünür; mobil arayüz desteklenir; “Made By Zirad.”, Buy Me a Coffee ve Discord bağlantıları korunur.
