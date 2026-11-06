# Tavla Online — Yayına Hazır v9

İki kişinin oda kodu veya davet bağlantısı ile internet üzerinden tavla oynamasını sağlayan Node.js / Express / Socket.IO projesi. **Hamachi, üyelik ve veritabanı gerekmez.**

## Neler değişti?

- Ana sayfa baştan düzenlendi: oda oluşturma, katılma ve kısa kullanım adımları; telefon/masaüstü uyumlu.
- Her elden sonra **kazanan oyuncu sıradaki ele başlar**. Rövanşta da önceki maçın kazananı başlar.
- 2x teklifinin zar animasyonu / otomatik zar ile çakışması giderildi. Teklif beklerken hamle ve zar ilerlemez.
- 2x teklifinde kabul, ret, bağlantı kopması ve teklifin bir kez kullanılması denetlendi.
- Türk tavlasında **mars 2 puandır**. 2x kabul edilirse normal galibiyet 2, mars 4 puan; ret halinde teklif sahibine 2 puan yazılır. Bu, bu uygulamanın **özel 2x kuralıdır** (standart tavla küpüyle birebir aynı değildir).
- Oyun içinde ve açılır teklif/maç pencerelerinde **Odadan Çık** eklendi. Bir kişi ayrılırsa oda iki oyuncu için kapanır.
- Rövanş için **iki oyuncunun da onayı** gerekir; tek kişi maçı sıfırlayamaz.
- Sekme bazlı oyuncu oturumu, yeniden bağlanma, eski oturumu devre dışı bırakma ve bağlantı kesilme durumları iyileştirildi.
- Oda oluşturma/katılma ve sohbet için hafif hız sınırları, temel HTTP güvenlik başlıkları ve mobil yatay taşma düzeltmeleri eklendi.
- Sunucu oyun kuralları ve oda olaylarını denetleyen otomatik testler eklendi.

## Bilgisayarda çalıştırma

Node.js 20 veya üzeri:

```bash
npm ci
npm start
```

Tarayıcıda `http://localhost:3000` adresini açın.

Testleri çalıştırmak için:

```bash
npm test
```

Bu sürümde 13 senaryolu otomatik test paketi bulunur. Ayrıca arayüz masaüstü/mobil tarayıcıda sahte soket olaylarıyla kontrol edilmiştir. **İki gerçek cihaz arasında canlı internet testi ve üretim yük testi ayrıca yapılmalıdır.**

## İnternette yayınlama

Ayrıntılı adımlar: [YAYINLAMA-REHBERI.md](YAYINLAMA-REHBERI.md).

- ZIP'i açıp içindeki dosyaları GitHub deposunun köküne yükle; ZIP dosyasını tek başına yükleme.
- Render Web Service için `npm ci` ve `npm start` kullan.
- `render.yaml` uygulama ayarlarını içerir, `/health` sağlık kontrolü vardır.
- Ortamın verdiği `PORT` kullanılır; erişim adresi barındırma sağlayıcısının HTTPS alan adıdır.

## Oyun nasıl çalışır?

1. Oyunculardan biri adını ve hedef puanını seçip oda açar.
2. Diğeri 5 karakterli kodla veya davet bağlantısından katılır.
3. Sırası gelen oyuncu zar atar (otomatik ya da manuel); hamle yapıp turu onaylar.
4. Taşlar tamamen ayrıldığında, sıradaki oyuncu zar atmadan önce bir kez 2x teklif edebilir. Otomatik zar bunu seçebilmek için kısa bir süre bekler.
5. Kazanan yeni ele başlar. Maç bitince iki oyuncu da isterse rövanş oynanır.
6. Odadan çıkış iki kişi için odayı kapatır. Geçici internet kesintisinde oyuncular aynı sekmeden yeniden bağlanabilir.

## Sınırlar

- **Oda, skor, sohbet ve maç verisi yalnızca sunucu RAM'inde tutulur.** Barındırıcı yeniden başlatılırsa veya ücretsiz barındırma uykuya girip uygulama yeniden başlarsa odalar kaybolabilir. Kalıcı kayıt, veri tabanı ve hesap sistemi yoktur.
- Her oda en çok 2 oyunculudur; ziyaretçi/seyirci modu ve eşleştirme sistemi yoktur.
- Aynı sekmede sayfa yenilemesi oyuncu kimliğini korur; farklı sekmeler birbirinden bağımsızdır. Sekmeyi tamamen kapatmak bağlantının geri yüklenmesini garanti etmez.
- Ticari ölçekte kullanım, saldırı dayanıklılığı ve yüksek trafik için ek geliştirme ve gerçek ortam testleri gereklidir.
