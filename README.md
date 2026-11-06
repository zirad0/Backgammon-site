# Tavla Online v8 — İnternete Hazır

**Hamachi olmadan internette yayınlamak için:** `YAYINLAMA-REHBERI.md` dosyasını oku.

Bu sürümde uygulama **aynı Wi-Fi ağındaki telefon ve tabletlerden de bağlanabilecek** hale getirildi.

## Kurulum

```bash
npm install
npm start
```

## Bilgisayardan açma

Tarayıcı:

```text
http://localhost:3000
```

## Telefondan / tabletten açma

1. Bilgisayar ve telefon **aynı Wi-Fi ağına** bağlı olsun.
2. Projeyi bilgisayarda çalıştır:

```bash
npm start
```

3. Terminalde şuna benzer bir adres göreceksin:

```text
http://192.168.1.37:3000
```

4. Telefonda tarayıcıya bu adresi yaz.
5. Windows Güvenlik Duvarı izin isterse **Özel ağlar / Private networks** için izin ver.

## Not

- Sunucu artık `0.0.0.0` üzerinde dinlediği için aynı yerel ağdaki cihazlar erişebilir.
- Eğer telefon yine bağlanamazsa Windows güvenlik duvarını ve kullandığın Wi-Fi ağının aynı olup olmadığını kontrol et.
- Modem izolasyonu olan bazı misafir ağlarında cihazlar birbirini göremez. Normal ev Wi-Fi ağında çalışır.

## Kolay düzenlenebilir klasörler

- `client/assets/checkers/`
  - taş görselleri burada
  - `white.svg` ve `black.svg`
- `client/assets/dice/`
  - zar görselleri burada
  - `1.svg` - `6.svg`
- `client/assets/sounds/`
  - ses efektleri burada
  - `roll.wav`, `move.wav`, `hit.wav`
- `client/assets/ui/texts.js`
  - arayüz yazıları burada

## Bu sürümde dikkat çekenler

- gelişmiş zar animasyonu
- chat sistemi ve mesaj saatleri
- tur sonu kazanan penceresi
- maç sonu büyük kazanan penceresi
- rövanş sistemi
- aynı ağdaki telefonlardan erişim
