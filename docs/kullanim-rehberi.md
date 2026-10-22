# Kamuİlan — sade kullanım rehberi

Teknik bilgi gerektirmez. Komutlar PowerShell'de, proje klasöründe çalıştırılır:

```powershell
cd D:\coding\claude\kamuradar
```

## Bilgisayarımda deneme (yerel)

```powershell
npm run dev
```

Tarayıcıda `http://localhost:5173` açılır. Giriş bilgileri yerel `.env` dosyasındaki `ADMIN_EMAIL` /
`ADMIN_PASSWORD` satırlarındadır. Yerel deneme **gerçek veritabanına dokunmaz** (`.env` içinde
`DATABASE_DRIVER=file`; bu satırı değiştirmeyin). Durdurmak için pencerede `Ctrl+C`.

## Sistem çalışıyor mu?

```powershell
npm run durum
```

Çıktının ilk satırı genel durumu söyler: **ÇALIŞIYOR**, **UYARI**, **KRİTİK** ya da **BİLİNMİYOR**.
Her satırın altında "→ Yapılacak" varsa ne yapılması gerektiği yazar. Worker (arka plan işçisi) durmuşsa
site açılıyor olsa bile sonuç KRİTİK'tir.

## Son taramayı nerede görürüm?

- Site → **Yönetim paneli → İlan kaynakları**: her kaynağın son taraması, başarısı, hata nedeni.
- `npm run durum` → "Kaynak taraması" satırı.

## Bir hata olursa

1. `npm run durum` çalıştırın.
2. Çıktının **tamamını** Claude Code'a yapıştırın ve "teşhis et ve düzelt" yazın.
3. Log dosyaları (açıksa) `logs\api.log` ve `logs\worker.log`; gerekirse Claude Code bunları kendisi okur.

Claude Code oturumu kapalıyken sistemi kendiliğinden izlemez; izleme `npm run durum` ve (canlıda) sunucunun
çıkış kodu 2'de alarm üretmesiyle yapılır.

## Kendiniz YAPMAYIN

- `.env` içindeki `DATABASE_DRIVER=file` satırını değiştirmek (yerel denemeyi gerçek veritabanına bağlar).
- Gerçek veritabanına karşı `npm run start:worker` çalıştırmak (tarama/e-posta başlatır).
- Sertifika doğrulamasını kapatmak (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `POSTGRES_SSL_MODE=no-verify`).
- Anahtarları sohbete, e-postaya ya da git'e yapıştırmak (anahtarlar Windows ortam değişkenlerinde durur).
- `config/source-terms.json`'da bir kaynağı incelemeden `allowed` yapmak.

## Canlıya çıkmak için kalan adımlar

Ayrıntılı ve sıralı yol: [uretime-cikis.md](./uretime-cikis.md). Kısaca:

1. Yeni (Frankfurt) veritabanında tabloları kurmaya onay vermek.
2. Sunucu seçimi (öneri: Oracle Cloud ücretsiz sunucu, Frankfurt) ve hesabın açılması.
3. Cloudflare erişimi (arayüz yayını).
4. Dağıtımdan sonra Telegram webhook'unun kurulması ve Telegram'da yeniden eşleşme.
5. İlk hafta her gün `npm run durum` ve Yönetim panelindeki inceleme kuyruğu.

## İlan etiketleme (doğruluk ölçümü)

```powershell
start data\etiketleme.html
```

Sayfadaki talimatları izleyin; bitince **Dışa aktar** ve indirilen dosyayı Claude Code'a verin.
