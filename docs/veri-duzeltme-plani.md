# Mevcut yanlış kayıtların düzeltme planı

Bu belge, veritabanındaki yanlış sınıflandırılmış kayıtların güvenli düzeltme sürecini anlatır.
Kapsam: `npm run jobs:reclassify` (`scripts/reclassify-jobs.ts`).

## Kurallar

1. **Önce kuru çalıştırma.** `--report <dosya>` yalnızca okur, hiçbir şeyi yazmaz. Bu, dosya
   deposu üzerinde sha256 ile doğrulandı (15 Ekim 2026: önce/sonra özet aynı).
2. **Silme yok.** Kayıt silinmez, birleştirilmez. Yalnızca kararı değişen alanlar güncellenir
   (`kind`, `status`, `title` temizliği, sınıflandırma sürümü).
3. **Kaynak ve kullanıcı kayıtları korunur.** Kaynak bağlantıları, `jobSources`, kullanıcı
   kaydetmeleri ve bildirim geçmişi değişmez.
4. **Yedek.** `--apply` yazmadan önce tam yedek alır (`writeJobsBackup`). Yedek yazılamazsa hiçbir
   kayıt değişmez.
5. **İdempotent.** Aynı komut ikinci kez çalıştırıldığında değişecek kayıt kalmaz.
6. **Bildirim bastırma.** Süreç duyurusuna dönüşen veya reddedilen kayıtların bekleyen
   bildirimleri bastırılır (`RECLASSIFY_NOTIFICATION_SUPPRESSION`). Geçmiş gönderimler geri
   alınamaz; raporda ayrıca gösterilir.
7. **Belirsiz kayıtlar otomatik değişmez.** Kanıt yetersizse kayıt incelemeye gider.

## Adımlar (Windows, yerel)

```powershell
cd C:\Users\Halil\Desktop\kamuradar-main

# 1) Kuru çalıştırma: yalnızca rapor. Veri değişmez.
npm run jobs:reclassify -- --report data\reclassify-dryrun.json

# 2) Raporu inceleyin: acceptedBefore / acceptedAfter, keptAsProcess, rejected, statusChanged,
#    kindChanged, notifications suppressed. Örnek listeleri gözden geçirin.

# 3) Onaydan sonra uygulama (yedek otomatik alınır). Onay vermeden ÇALIŞTIRMAYIN.
npm run jobs:reclassify -- --apply --report data\reclassify-applied.json
```

**Önemli:** `.env` dosyasında `DATABASE_DRIVER` değerinin hedef veritabanı olduğunu kontrol edin.
Supabase'de çalıştırmadan önce bu belgedeki kuru çalıştırma adımını mutlaka yapın.

## Bu ortamda yapılanlar

- Demo deposunda (`npm run seed:demo`, `provenance: sample`) kuru çalıştırma: 3 kayıt, 0 değişiklik,
  dosya sha256 aynı. Gerçek kayıtlar bu ortamda yok.
- Uygulama yolu (`--apply`) birim/entegrasyon testleriyle kapsanır (`tests/reclassify-roundtrip.test.ts`,
  `tests/process-notice-notifications.test.ts`). Gerçek Supabase verisinde çalıştırılmadı.

## Kullanıcının çalıştırdığı son kuru çalıştırmaya göre dikkat edilecekler

Kabul kuralı değişti (başlıkta alım kanıtı olmayan gövde kabulleri artık `review`). Bu nedenle
14 Ekim'deki onaylı rakamlar (26 kabul / 5 süreç / 30 ret) güncel olmayabilir. Yeni kuru
çalıştırmada `acceptedAfter` artabilir veya `review` kayıtları ayrı görünebilir. Bu rapor sonucu
ölçülmeden tahmin yapılmamıştır.
