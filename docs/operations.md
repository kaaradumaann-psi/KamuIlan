# İşletim el kitabı

## 1. Sistem sağlığı

| Ne                  | Nereden                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Genel durum         | `GET /api/health` → `status`, `warnings`, `database`, `scans`, `workers`, `queue`, `sources` |
| Kaynak bazlı durum  | `GET /api/sources`, `GET /api/sources/:key/status`                                           |
| Worker kalp atışı   | Yönetim → Özet (`workers`) veya `workerHeartbeats` koleksiyonu                               |
| Zamanlama gecikmesi | `scans.lastSuccessAt`, `minutesSinceSuccess`, `scheduleLagWarning` (Yönetim → Kuyruk)        |
| Kuyruk              | Yönetim → Kuyruk & kilitler: bekleyen/aktif/ölü işler, süresi geçmiş kilitler                |
| E-posta hattı       | Yönetim → E-posta kuyruğu: `pending/sending/accepted/failed/dead/suppressed`                 |
| İnceleme kuyruğu    | Yönetim → İnceleme kuyruğu (sınıflandırma, tekilleştirme, çıkarım)                           |

`degraded` durumu genellikle kaynak kaynaklıdır (ör. coğrafi kısıtlı kaynak veya
ağ erişimi olmayan geliştirme ortamı). `warnings` alanı hangi kaynağın hangi
nedenle sorunlu olduğunu yazar.

## 2. Rutin bakım

| Görev                                           | Aralık          | Komut / yer                                                                     |
| ----------------------------------------------- | --------------- | ------------------------------------------------------------------------------- |
| İndeks kontrolü                                 | Dağıtım sonrası | `npm run db:indexes`                                                            |
| Kaynak envanteri + görevler                     | Dağıtım sonrası | `npm run db:migrate`                                                            |
| Kapsam raporu                                   | Haftalık        | `npm run sources:report` (`--json` CI için)                                     |
| Süresi geçmiş kilit/oturum/hız sınırı temizliği | Günlük          | Worker otomatik yapar (bakım işi)                                               |
| 7 günden eski worker kalp atışı kayıtları       | Günlük          | Worker otomatik yapar (geliştirmede yeniden başlatmalar yanlış alarm üretmesin) |
| Son başvuru durumlarının yenilenmesi            | 12 saatte bir   | Worker ("deadline-refresh" görevi)                                              |
| Kapsam denetimi                                 | Günlük          | Worker ("coverage-audit" görevi)                                                |
| Yedek                                           | Günlük          | aşağıya bakın                                                                   |
| Eski ilan kayıtlarını yeniden sınıflandırma     | Kural değişince | `npm run jobs:reclassify` (kuru), `--report` ile inceleme, sonra `-- --apply`   |

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
5. **Kaynak sürekli atlanıyor** — Tarama kaydı `status='skipped'` ve mesaj
   "toplanamadı (atlandı)" ise kaynak yöntemsel olarak çalıştırılamıyordur
   (ör. başsız tarayıcı kurulu değil, erişim kısıtlı). Atlama da sağlık
   sayacını artırır, çünkü kaynak hiç toplanamıyordur; çözüm ya bağımlılığı
   kurmak (`npx playwright install chromium`) ya da kaynağı `needs-manual-method`
   olarak işaretlemektir. **Engel aşılmaz.**
6. **Tarama aralığı** — `SCAN_INTERVAL_MINUTES=0` her kaynağı kendi
   `intervalMinutes` değeriyle tarar (önerilen). Pozitif bir değer tüm kaynak
   görevlerine aynı aralığı yazar; en küçük değer 15 dakikadır (daha küçük değerler
   15'e yükseltilir). Bu ayar `db:migrate` ve worker başlangıcında mevcut görevlere de
   yazılır. Her kaynağın `minRequestIntervalMs` sınırı yine uygulanır ve aynı kaynak
   iki kez eşzamanlı taranmaz.

## 3.1 Uyarı gürültüsünü önleme

Yönetici uyarıları (uzun süredir başarısız kaynak, ölü kuyruk işi, kalp atışı
kesilen worker) worker tikinde kontrol edilir; ancak **aynı uyarı yalnızca durum
değiştiğinde veya 6 saatte bir** tekrarlanır, `auditLogs` kaydı da yalnızca
durum değişiminde yazılır. Aksi hâlde her tik logu ve denetim kaydını doldururdu.

Geliştirmede `tsx watch` worker'ı her dosya değişiminde yeniden başlattığı için
eski süreçlerin kalp atışı kayıtları kalır. Worker başlarken `heartbeatStaleMs`
(2 dakika) eşiğini geçen kayıtlar otomatik olarak **stopped** işaretlenir ve
bakım işi 7 günden eski kayıtları siler; panelde sahte "çalışıyor" görünmez.

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

### Supabase (Postgres) — üretim

```bash
# Supabase Dashboard → Database → Backups (günlük otomatik yedek, Pro planda PITR)
# Ek/bağımsız yedek: bağlantı dizesiyle pg_dump (supabase CLI ya da yerel pg_dump)
pg_dump "$POSTGRES_URL" --schema=public --no-owner \
  --table='kamuilan_*' --file=/backup/kamuilan-$(date +%F).sql

# Geri yükleme (boş bir projeye/şemaya)
psql "$POSTGRES_URL" --file=/backup/kamuilan-2026-10-12.sql
```

Yedek kapsamı: `kamuilan_sources`, `kamuilan_jobs`, `kamuilan_job_sources`,
`kamuilan_job_revisions`, `kamuilan_users`, `kamuilan_sessions`,
`kamuilan_notification_preferences`, `kamuilan_notification_events`,
`kamuilan_email_outbox`, `kamuilan_scrape_runs`, `kamuilan_review_queue`,
`kamuilan_audit_logs`, `kamuilan_scheduled_tasks`, `kamuilan_clusters`,
`kamuilan_worker_heartbeats`. Atılabilir: `kamuilan_rate_limits`,
`kamuilan_locks`, `kamuilan_queue_jobs`.

Geri yükleme sonrası: `npm run db:indexes && npm run db:migrate`, ardından
`GET /api/health` ve `npm run sources:report` ile doğrulayın.

### MongoDB (alternatif)

```bash
# Yedek (sıkıştırılmış)
mongodump --uri="$MONGODB_URI" --db=kamuilan --gzip --archive=/backup/kamuilan-$(date +%F).gz \
  --excludeCollection=rateLimits --excludeCollection=locks

# Geri yükleme (boş bir veritabanına)
mongorestore --uri="$MONGODB_URI" --nsFrom='kamuilan.*' --nsTo='kamuilan.*' \
  --gzip --archive=/backup/kamuilan-2026-10-12.gz
```

Yedekleme kapsamı: `sources`, `jobs`, `jobSources`, `jobRevisions`, `users`,
`sessions` (isteğe bağlı), `notificationPreferences`, `notificationEvents`,
`emailOutbox`, `scrapeRuns`, `reviewQueue`, `auditLogs`, `scheduledTasks`,
`clusters`, `workerHeartbeats`. Atılabilir: `rateLimits`, `locks`, `queueJobs`.

Geri yükleme sonrası: `npm run db:indexes && npm run db:migrate` çalıştırın,
sonra `GET /api/health` ve `npm run sources:report` ile doğrulayın.

### Dosya deposu (geliştirme)

```bash
cp data/kamuilan.json /backup/kamuilan-$(date +%F).json
```

Geri yüklemede dosyayı yerine kopyalayın; uygulama açılışta indeksleri yeniden kurar.

## 6. E-posta hattı

- Geliştirme: `npm run dev:smtp` → http://localhost:1080 (gerçek gönderim yok).
- Üretim (öntanımlı): **Resend** — `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`,
  doğrulanmış alan adından `EMAIL_FROM`. Alternatif: `SMTP_HOST/PORT/USER/PASS`.
  Üretimde hiçbiri yoksa uygulama başlamaz (sessiz kayıp olmasın).
- Resend tarafında teslim/bounce/şikâyet raporları Resend panelinden izlenir;
  Kamuİlan yalnızca "sağlayıcı kabul etti" bilgisini saklar. Şüpheli artışta
  `EMAIL_FROM` alan adının SPF/DKIM kayıtlarını kontrol edin.
- Durumlar: `pending` → `sending` → `accepted` | `failed` → (`dead`).
  "accepted", sağlayıcının iletiyi kabul ettiğini gösterir; "teslim edildi"
  bilgisi verilmez.
- Yeniden deneme: `EMAIL_RETRY_BASE_MS` × 2^(deneme) + jitter, `EMAIL_MAX_ATTEMPTS`
  sonrası ölü mektup.
- Abonelikten çıkma jetonu ve doğrulama jetonları `EMAIL_VERIFICATION_SECRET`
  (yoksa `APP_SECRET`) ile imzalanır; sır değişirse eski bağlantılar geçersiz olur.

## 7. Olay müdahalesi (runbook)

| Belirti                          | İlk adım                                                     | Kalıcı çözüm                                                                                      |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| API yanıt vermiyor               | `GET /api/health`, süreç günlüğü                             | Süreci yeniden başlat; MongoDB/Redis bağlantısını kontrol et                                      |
| Zamanlanmış taramalar durdu      | `/api/health/worker`, `/api/health/config`, Yönetim → Kuyruk | Worker heartbeat'ini ve `SCHEDULER_ENABLED` ayarını kontrol et; kuyrukta kalan işleri ayrıca izle |
| E-postalar gitmiyor              | Yönetim → E-posta kuyruğu `lastError`                        | SMTP bilgilerini düzelt; ölü işleri yeniden kuyruğa al                                            |
| İlanlar artıyor ama bildirim yok | Kullanıcı tercihlerini ve doğrulama durumunu kontrol et      | Doğrulanmamış adrese gönderim yapılmaz (bilinçli)                                                 |
| Aynı ilan iki kayıt              | İnceleme kuyruğu → birleştirme                               | Kural eşiğini gözden geçir; benzer başlıklı farklı ilanlar OTOMATİK birleştirilmez                |
| Yanlış ilan kabul edilmiş        | İnceleme kuyruğu → reddet                                    | Sınıflandırma kuralını güncelle + test ekle (`tests/classification.test.ts`)                      |

`SCHEDULER_ENABLED=0`, yalnızca zamanı gelen görevlerin kuyruğa eklenmesini
bekletir. Worker heartbeat'i sürer; önceden kuyruğa alınmış işler ve e-posta
outbox'ı işlenmeye devam eder (`EMAIL_PROVIDER` taşıyıcıyı belirler). Bütün worker
faaliyetlerini durdurmak için worker sürecini durdurun.

## 8. Günlük ve gizlilik

- Günlükler pino ile JSON yazılır; e-posta adresleri maskelenir (`t***@ornek.test`).
- Sırlar loglanmaz; `describeEnv()` yalnızca maskeli özet verir.
- Yönetici işlemleri `auditLogs` koleksiyonuna yazılır (kim, ne zaman, ne yaptı).

## 9. Telegram ve yapay zekâ hattı

- **Telegram teslimi**: Bildirimler e-postayla aynı outbox üzerinden gider. 429 yanıtında `retry_after`
  beklenir; 403 ve bazı 400 yanıtlarında bağlantı `blocked` olur ve bir daha denenmez. Ağ, 5xx,
  401/404/409 hatalarında yeniden denenir. Durum izleme: Panelde Telegram kartı ve `npm run telegram:webhook -- info`.
- **Webhook sırrı döndürme**: Yeni sırrı `.env`'e yazın, API'yi yeniden başlatın, ardından
  `npm run telegram:webhook -- set` çalıştırın. Sıra ters olursa Telegram eski sırla istek atar ve 401 döner.
- **Yapay zekâ maliyeti**: `AI_DAILY_LIMIT_PER_USER` ile kullanıcı başına günlük çağrı sınırlanır. Sayaç
  `ai-daily:<kullanıcı>` kovasında tutulur. Sağlayıcı zaman aşımı `LLM_TIMEOUT_MS` ile sınırlıdır.
- **Yapay zekâ hata ayıklama**: Denetim kaydında yalnızca `ai.suggestions` olayları vardır (`mode`, `candidateCount`,
  `suggestionCount`, `modelCalled`). Model içeriği ve profil verisi loglanmaz; hata metinlerinde API anahtarı maskelenir.
- **Acil kapatma**: `AI_ASSISTANT_ENABLED=0` ile API yeniden başlatıldığında uçlar 503 döner ve Panelim'deki
  "Bana uygun ilanlar" kartı gizlenir (`/api/ai/status` → `enabled: false`). Telegram için `TELEGRAM_BOT_TOKEN`
  boşaltılıp API yeniden başlatılırsa kanal kapanır; bağlantı kayıtları silinmez ve token geri konduğunda devam eder.

## 10. LLM sınıflandırma kapısı (ingest)

- **Ne zaman çalışır**: yalnızca worker taramasında ve yalnızca kural motorunun `review` dediği kayıtlarda.
  `LLM_CLASSIFIER_ENABLED=1` + `LLM_BASE_URL/LLM_API_KEY/LLM_CLASSIFIER_MODEL` (veya `LLM_MODEL`) gereklidir.
- **Maliyet frenleri**: koşu başına `LLM_MAX_CALLS_PER_RUN` (12), günlük `LLM_DAILY_CALL_LIMIT` (400,
  `llm-classifier-daily` kovası), eşzamanlılık `LLM_MAX_CONCURRENCY` (2), retry `LLM_RETRY_MAX` (1; yalnız
  429/5xx/zaman aşımı). Önbellek (içerik özeti + model + istem sürümü) tekrar eden içeriği ücretsiz yapar.
- **Telemetri**: `llmAnalyses` koleksiyonu (çağrı, önbellek isabeti, token, gecikme, hata, doğrulanamayan
  çıktı). Panel: Yönetici → Genel bakış → LLM kartı. Ham ilan metni ve API anahtarı yazılmaz/loglanmaz.
- **Güvenli davranış**: sağlayıcı hatası/geçersiz çıktı/kanıt doğrulanamadı → kayıt inceleme kuyruğunda
  kalır ve kuyrukta "yapay zekâ ön görüşü" görünür. Hiçbir belirsiz kayıt otomatik onaylanmaz.
- **Bakım**: 90 günden eski telemetri kayıtları worker bakım görevinde temizlenir. İstem/model sürümü
  değişince `src/ai/classifier.ts` içindeki `LLM_PROMPT_VERSION` artırılmalıdır (önbellek kontrollü yenilenir).
- **Acil kapatma**: `LLM_CLASSIFIER_ENABLED=0` + worker yeniden başlat; yayımlanmış ilanlar etkilenmez.
- **Eski kayıt birikimi**: `npm run llm:review-assist -- --report rapor.json` (kuru çalıştırma; ana
  veritabanına yazmaz). Uygulama: panel → İnceleme kararları veya kapı açıkken sonraki tarama.
