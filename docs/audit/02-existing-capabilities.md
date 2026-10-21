# 02 — Mevcut Yetenekler (kanıtlı envanter)

Bu belge **kodda gerçekten olan** yetenekleri listeler. Her satırda kanıt dosyası
vardır. Kanıtlanmayan hiçbir şey "var" sayılmadı. Kanıt düzeyleri:
**[1]** doğrudan kod/çalıştırma, **[2]** tekrarlanabilir test, **[3]** güçlü olasılık,
**[4]** henüz doğrulanamadı, **[5]** kapsam dışı.

## 1. Tek cümlelik durum

Kamuİlan; resmî kaynaklardan ilan toplayan, kuralla sınıflandıran, alanları kanıt
iziyle çıkaran, tekilleştiren, sürümleyen, e-posta/Telegram ile bildiren ve
yönetim paneli olan **çalışan bir tek-oligon (tek kurum/iç kullanım) uygulamasıdır**.
Eksik olan şey veri toplama değil, **halka açık erişim ve ölçek**tir (bkz. 03/R-01, R-03).

## 2. Özellik envanteri

| Alan | Durum | Kanıt | Sınır / not |
| --- | --- | --- | --- |
| Kaynak tanımları | **VAR** — 28 kaynak (24 `enabled`, 4 kapalı) | `src/config/sources.ts` | README hâlâ "27 kayıtlı kaynak" diyor → **R-14** |
| Adaptörler | **VAR** — 10 kayıtlı adaptör kimliği (8 dosya): `anchor-list`, `ilan-gov-tr`, `ilan-gov-tr-api`, `kariyerkapisi`, `osym`, `resmigazete`, `sbb-kamuilan`, `manual-entry` | `src/sources/adapters/` | Kaynak başına seçim `src/config/sources.ts` |
| HTTP istemcisi | **VAR** — SSRF savunması (DNS cevabı doğrulama), elle yönlendirme + her adımda allowlist, host başına aralık, Retry-After, gövde boyutu sınırı, ETag/Last-Modified | `src/sources/fetcher.ts`, `src/sources/network-safety.ts` | TLS doğrulaması kapatılmıyor; AIA ile zincir tamamlama opsiyonel |
| PDF metni | **VAR** | `src/extraction/pdf.ts`, `scripts/make-pdf-fixtures.ts` | Taranmış görüntü PDF'lerde OCR **yok** [1] |
| Tarama hattı | **VAR** — liste → ön karar → detay bütçesi → çıkarım → sınıflandırma → tekilleştirme | `src/ingest/` | Liste drenajı ve bütçe testleri var |
| Zamanlama | **VAR** — `scheduler.ts` + `scheduledTasks` + kilitler + heartbeat | `src/worker/` | Varsayılan **kapalı** (`SCHEDULER_ENABLED=0`) |
| Sınıflandırma | **VAR** — kural motoru; `reject` / `review` / `accept`, `kind: job｜process` | `src/classification/engine.ts`, `rules.ts` | Eşikler: kabul ≥3, inceleme ≥1; kanıt kapısı zorunlu |
| Haber/duyuru kapısı | **YENİ (bu denetim)** — haber dili + somut başvuru kanıtı yok → `reject`, kanıt varsa `review` | `detectNewsReport()`; `tests/classification-haber-dili.test.ts` | Gerçek ölçüm yok; sentetik haber başlıklarıyla regresyon |
| LLM sınıflandırma kapısı | **VAR, varsayılan KAPALI** — yalnızca `review` kayıtlarda, kanıt doğrulamalı | `src/ai/classifier.ts` | Anahtar/yetki yoksa devre dışı |
| Alan çıkarımı | **VAR** — tarih (TR saati, yılsız ifadeden tarih üretmez), kontenjan, il, öğrenim, bölüm, KPSS türü/puanı, başvuru URL'si, ekler | `src/extraction/engine.ts`, `src/domain/dates.ts` | Kanıt alıntısı `fieldSources` ile saklanır |
| Tekilleştirme | **VAR** — kaynak kimliği, resmî ilan no, kanonik URL, başlık benzerliği, kurum + dönem + metin | `src/ingest/dedupe.ts` | Eşikler `DEDUPE_THRESHOLDS` |
| Sürüm/iz | **VAR** — `jobRevisions`, `jobSources`, `sourceItemDecisions`, `scrapeRuns` | `src/db/schemas.ts`, `src/db/repos/` | Değişiklik türleri: içerik, süre, durum, geri çekme |
| İptal/geri çekme | **VAR** — kanıtla hedef seçimi; kanıtsızsa insan incelemesi | `selectWithdrawalTarget()`, `detectWithdrawalSignal()` | Bu denetimde güçlendirildi (P0) |
| Durum modeli | **VAR** — `upcoming/active/closed/cancelled/unknown` + gerekçe | `src/domain/dates.ts`, `src/ingest/jobs-service.ts` | Son gün gün sonuna kadar açık |
| Arama/filtre | **VAR** — metin, kurum, il, tür, süreç/ilan, durum, tarih aralığı, kontenjan, öğrenim, bölüm, KPSS türü/puanı, başvuru bağlantısı, sıralama, sayfalama | `src/server/routes/jobs.ts`, `src/db/repos/jobs.ts` | `?hasApplicationUrl=false` düzeltildi (P2) |
| Sorgu motoru | **VAR** — dosya/Mongo/Postgres için ortak dil | `src/db/query.ts` | `$exists` iki yönlü düzeltildi (P2) |
| Kimlik doğrulama | **VAR** — scrypt özet, sunucu tarafı oturum, jetonlar yalnızca özet olarak, e-posta doğrulama, parola sıfırlama, hesap silme | `src/server/passwords.ts`, `routes/auth.ts`, `src/db/repos/users.ts` | Kayıt varsayılan **kapalı** (`ALLOW_PUBLIC_REGISTRATION=0`) |
| CSRF | **VAR** — çift gönderim + `safeEqual`; oturumlu değiştirici isteklerde zorunlu | `src/server/app.ts` | `unsubscribe` muafiyeti kaldırıldı (P1) |
| Hız sınırı | **VAR** — kimlik uçları ve genel API için ayrı kova | `src/server/app.ts` | Varsayılanlar `.env.example`'da [1] |
| Kaydetme | **VAR** — `savedJobs` | `routes/jobs.ts`, `pages/Saved.tsx` | — |
| Bildirim | **VAR** — e-posta (SMTP/file), Telegram bot, tercih eşleştirme, olay + outbox + yeniden deneme | `src/notifications/`, `src/email/`, `src/telegram/` | Sağlayıcı yoksa e-posta gönderilmez (varsayılan `file`) |
| Yönetim paneli | **VAR** — 9 sekme: özet, kaynaklar, taramalar, inceleme, e-posta, kuyruk, kapsam, kullanıcılar, denetim | `src/pages/Admin.tsx` | Tüm uçlar `requireAdmin` |
| Denetim kaydı | **VAR** — `auditLogs` | `routes/admin.ts` | — |
| Sağlık/izleme | **VAR** — `/api/health`, `/api/health/worker`, istek kimliği, JSON log | `src/server/routes/health.ts`, `src/lib/logger.ts` | Üretim sağlığı **ölçülmedi** [4] |
| AI asistanı | **VAR, varsayılan KAPALI** — açık rıza, günlük koşum/çağrı/maliyet bütçesi, zaman aşımı, JSON doğrulama, yedek sonuç | `src/ai/` | Model/fiyat env'den; fiyat yoksa çağrı yapılmaz |
| Değerlendirme | **VAR** — sınıflandırma ve çıkarım eval koşucuları | `scripts/eval-*.ts`, `src/classification/eval.ts` | Sınıflandırma seti **17 sentetik** kayıt; gerçek altın küme yok → **R-04** |
| Yedek/geri yükleme | **KISMİ** — reclassify öncesi yedek + geri yükleme betiği | `scripts/reclassify-jobs.ts`, `scripts/restore-jobs-backup.ts` | Otomatik/zamanlanmış DB yedeği **görülmedi** [4] |
| Test altyapısı | **VAR** — 122 dosya / 1409 test, 5 driver + API + UI | `tests/`, `e2e/` | E2E **BLOCKED** (tarayıcı yok) → 04 |

## 3. Açıkça OLMAYAN yetenekler (yanlış varsayımı önlemek için)

| Beklenen | Gerçek durum | Kanıt |
| --- | --- | --- |
| Herkese açık ilan sayfaları | **YOK** — oturum yoksa liste/detay açılmaz | `src/App.tsx`, `tests/app-gate.test.tsx` |
| SEO: sitemap, sayfa başına meta, `llms.txt` | **YOK** — `public/` yalnızca `robots.txt`, `_headers`, `favicon.svg`; SPA başlığı sabit | `public/`, `index.html` |
| Kadro bazlı kırılım (unvan × il × kontenjan) | **YOK** — tek `quota`, `cities`, `titles` | `src/domain/types.ts` |
| Kurum/il/bölüm hub sayfaları | **YOK** — yalnızca filtre parametreleri | `src/pages/Jobs.tsx` |
| Ayrı "arşiv/iptal" sekmesi | **YOK** — durum filtresi var | `src/components/Filters.tsx` |
| RLS / satır düzeyi güvenlik | **YOK** — uygulama kendi yetkilendirmesini yapıyor; DB kimliği tek | 01 numaralı belge |
| OCR | **YOK** | `src/extraction/pdf.ts` |
| Çoklu dil | **YOK** — yalnızca Türkçe | `index.html`, i18n katmanı yok |
| Mobil uygulama / PWA | **YOK** — manifest/service worker görülmedi | `public/` |

## 4. Bu denetimde eklenenler

| Eklenen | Dosya | Kanıt |
| --- | --- | --- |
| Haber dili kapısı | `src/classification/rules.ts`, `src/classification/engine.ts` | `tests/classification-haber-dili.test.ts` (6 test) |
| Gerçek kaynak regresyonu (İçişleri duyuruları, 10 gerçek başlık) | `tests/fixtures/gercek-ilanlar/2026-10-21-icisleri-duyurular.json` | `tests/gercek-kaynak-icisleri-regresyon.test.ts` (4 test) |
