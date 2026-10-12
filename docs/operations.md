# İşletim el kitabı

## 1. Sistem sağlığı

| Ne | Nereden |
| --- | --- |
| Genel durum | `GET /api/health` → `status`, `warnings`, `database`, `scans`, `workers`, `queue`, `sources` |
| Kaynak bazlı durum | `GET /api/sources`, `GET /api/sources/:key/status` |
| Worker kalp atışı | Yönetim → Özet (`workers`) veya `workerHeartbeats` koleksiyonu |
| Zamanlama gecikmesi | `scans.lastSuccessAt`, `minutesSinceSuccess`, `scheduleLagWarning` (Yönetim → Kuyruk) |
| Kuyruk | Yönetim → Kuyruk & kilitler: bekleyen/aktif/ölü işler, süresi geçmiş kilitler |
| E-posta hattı | Yönetim → E-posta kuyruğu: `pending/sending/accepted/failed/dead/suppressed` |
| İnceleme kuyruğu | Yönetim → İnceleme kuyruğu (sınıflandırma, tekilleştirme, çıkarım) |

`degraded` durumu genellikle kaynak kaynaklıdır (ör. coğrafi kısıtlı kaynak veya
ağ erişimi olmayan geliştirme ortamı). `warnings` alanı hangi kaynağın hangi
nedenle sorunlu olduğunu yazar.

## 2. Rutin bakım

| Görev | Aralık | Komut / yer |
| --- | --- | --- |
| İndeks kontrolü | Dağıtım sonrası | `npm run db:indexes` |
| Kaynak envanteri + görevler | Dağıtım sonrası | `npm run db:migrate` |
| Kapsam raporu | Haftalık | `npm run sources:report` (`--json` CI için) |
| Süresi geçmiş kilit/oturum/hız sınırı temizliği | Günlük | Worker otomatik yapar (bakım işi) |
| 7 günden eski worker kalp atışı kayıtları | Günlük | Worker otomatik yapar (geliştirmede yeniden başlatmalar yanlış alarm üretmesin) |
| Son başvuru durumlarının yenilenmesi | 12 saatte bir | Worker ("deadline-refresh" görevi) |
| Kapsam denetimi | Günlük | Worker ("coverage-audit" görevi) |
| Yedek | Günlük | aşağıya bakın |

Bakım işlerini elle tetiklemek için Yönetim → Kaynaklar → "Bakımı çalıştır" veya
`POST /api/admin/maintenance/:kind`.

## 3. Kaynak sorunları

1. **Kaynak 403/engel döndürüyor** — Kanıtı güncelleyin (`statusNote`,
   `verificationEvidence`) ve durumu `access-restricted` yapın. Engel AŞILMAZ.
2. **HTML yapısı değişti** — Tarama kaydı "yapı değişmiş olabilir" hatası verir ve
   kaynak sağlığı `consecutiveFailures` artar. Adaptörü ve test fixture'ını
   güncelleyin (bkz. [source-onboarding.md](./source-onboarding.md)).
3. **Kaynak uzun süre başarısız** — Yönetim panelinde uyarı görünür. Kaynağı
   geçici olarak kapatabilirsiniz; **kapatma mevcut ilanları silmez**.
4. **Aralık değiştirme** — Yönetim → Kaynaklar → aralık alanı (dakika). Hızlı
   kaynaklar 30–60 dk, kurumsal sayfalar 2–6 saat, keşif işleri günlük.

## 4. Kuyruk ve ölü işler

- **Ölü tarama işi** (`queueJobs.status='dead'`): Yönetim → Kuyruk → "Yeniden dene".
  Neden öldüğünü `lastError` alanından okuyun.
- **Ölü e-posta** (`emailOutbox.status='dead'`): Yönetim → E-posta kuyruğu →
  "Yeniden kuyruğa al". SMTP kimlik bilgilerini ve gönderim sınırlarını kontrol edin.
- **Süresi geçmiş kilit**: Kaynak taranırken süreç çöktüyse kilit TTL ile temizlenir;
  acil durumda Yönetim → Kuyruk ekranından kilit temizlenebilir.
- **Aynı kaynağın iki kez taranması**: Kilitler ve kuyruk talebi anahtarları bunu
  engeller (test edilmiştir). Yine de şüphe varsa `locks` koleksiyonuna bakın.

## 5. Yedekleme ve geri yükleme

### MongoDB

```bash
# Yedek (sıkıştırılmış)
mongodump --uri="$MONGODB_URI" --db=kamuradar --gzip --archive=/backup/kamuradar-$(date +%F).gz \
  --excludeCollection=rateLimits --excludeCollection=locks

# Geri yükleme (boş bir veritabanına)
mongorestore --uri="$MONGODB_URI" --nsFrom='kamuradar.*' --nsTo='kamuradar.*' \
  --gzip --archive=/backup/kamuradar-2026-10-12.gz
```

Yedekleme kapsamı: `sources`, `jobs`, `jobSources`, `jobRevisions`, `users`,
`sessions` (isteğe bağlı), `notificationPreferences`, `notificationEvents`,
`emailOutbox`, `scrapeRuns`, `reviewQueue`, `auditLogs`, `scheduledTasks`,
`clusters`, `workerHeartbeats`. Atılabilir: `rateLimits`, `locks`, `queueJobs`.

Geri yükleme sonrası: `npm run db:indexes && npm run db:migrate` çalıştırın,
sonra `GET /api/health` ve `npm run sources:report` ile doğrulayın.

### Dosya deposu (geliştirme)

```bash
cp data/kamuradar.json /backup/kamuradar-$(date +%F).json
```

Geri yüklemede dosyayı yerine kopyalayın; uygulama açılışta indeksleri yeniden kurar.

## 6. E-posta hattı

- Geliştirme: `npm run dev:smtp` → http://localhost:1080 (gerçek gönderim yok).
- Üretim: `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`. Üretimde SMTP yoksa uygulama
  başlamaz (sessiz kayıp olmasın).
- Durumlar: `pending` → `sending` → `accepted` | `failed` → (`dead`).
  "accepted", sağlayıcının iletiyi kabul ettiğini gösterir; "teslim edildi"
  bilgisi verilmez.
- Yeniden deneme: `EMAIL_RETRY_BASE_MS` × 2^(deneme) + jitter, `EMAIL_MAX_ATTEMPTS`
  sonrası ölü mektup.
- Abonelikten çıkma jetonu ve doğrulama jetonları `EMAIL_VERIFICATION_SECRET`
  (yoksa `APP_SECRET`) ile imzalanır; sır değişirse eski bağlantılar geçersiz olur.

## 7. Olay müdahalesi (runbook)

| Belirti | İlk adım | Kalıcı çözüm |
| --- | --- | --- |
| API yanıt vermiyor | `GET /api/health`, süreç günlüğü | Süreci yeniden başlat; MongoDB/Redis bağlantısını kontrol et |
| Taramalar durdu | Yönetim → Kuyruk, kalp atışı | Worker'ı yeniden başlat; `SCHEDULER_ENABLED` değerini kontrol et |
| E-postalar gitmiyor | Yönetim → E-posta kuyruğu `lastError` | SMTP bilgilerini düzelt; ölü işleri yeniden kuyruğa al |
| İlanlar artıyor ama bildirim yok | Kullanıcı tercihlerini ve doğrulama durumunu kontrol et | Doğrulanmamış adrese gönderim yapılmaz (bilinçli) |
| Aynı ilan iki kayıt | İnceleme kuyruğu → birleştirme | Kural eşiğini gözden geçir; benzer başlıklı farklı ilanlar OTOMATİK birleştirilmez |
| Yanlış ilan kabul edilmiş | İnceleme kuyruğu → reddet | Sınıflandırma kuralını güncelle + test ekle (`tests/classification.test.ts`) |

## 8. Günlük ve gizlilik

- Günlükler pino ile JSON yazılır; e-posta adresleri maskelenir (`t***@ornek.test`).
- Sırlar loglanmaz; `describeEnv()` yalnızca maskeli özet verir.
- Yönetici işlemleri `auditLogs` koleksiyonuna yazılır (kim, ne zaman, ne yaptı).
