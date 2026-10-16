# Kamuİlan — Uçtan Uca Denetim ve Düzeltme Raporu

**Tarih:** 16.10.2026
**Dal:** `arena/7ae2fdfa-kamuradar` (başlangıç commit'i: `a777f38`, `main`)
**Ortam:** Linux sandbox, Node `v22.22.3`, `npm ci` ile 387 paket
**Kısıtlar (uyuldu):** gerçek `.env`/API anahtarı yok · üretim veritabanına hiç dokunulmadı · gerçek e-posta/Telegram gönderilmedi · gerçek kaynak taranmadı (worker başlatılmadı) · branch değiştirilmedi, force push/geçmiş yazımı yapılmadı · ücretli API çağrısı yapılmadı.

---

## A) Genel durum

| Konu | Durum | Kanıt |
|---|---|---|
| Gerçek API anahtarı / `.env` | **Yok** | `npm run env:check` → `envFile: yok (yalnızca ortam değişkenleri)` |
| Gerçek LLM çağrısı | **Test edilemedi / engellendi** | `npm run llm:doctor -- --json` → `classifierEnabled:false`, `assistantEnabled:false`, `checks.*: "bilinmiyor"` |
| İki LLM kapısının davranışı | **Sahte sağlayıcı (fake fetch) + mock sunucu ile test edildi** | `tests/llm-gate.test.ts`, `tests/llm-provider-mock-server.test.ts`, yeni `tests/senaryo-siniflandirma-ai.test.ts`, `tests/senaryo-panel-oneri.test.ts` |
| Gerçek kaynak HTML'i | **Test edilemedi** (canlı tarama yapılmadı) | Sahte adaptör + kayıtlı fixture'larla çalışıldı (`tests/fixtures/`, `tests/senaryo-toplama-akisi.test.ts`) |
| Veritabanı | **Dosya deposu** (üretim DB'si değil) | `env:check` → `database: file:./data`, `dbTls: yok` |
| E-posta | **Gerçek gönderim kapalı** | `env:check` → `email: dosya (geliştirme; e-posta gönderilmez)` |
| Maliyet ölçümü | **Doğrulanamadı** | `LLM_COST_USD_PER_MTOK_INPUT/OUTPUT` boş → maliyet `null` raporlanıyor (fiyat uydurulmadı) |
| Gerçek doğruluk (precision/recall) | **Ölçülemedi** | `npm run eval:classification` → 17 kayıt, **0 insan doğrulamalı gerçek kayıt**; araç kendisi "VERİ YETERSİZ — gerçek dünya doğruluğu olarak SUNULAMAZ" diyor |
| Tarayıcı/uçtan uca (Playwright) | **Çalıştırılmadı** | Gerekçe: canlı sunucu + tarayıcı gerekiyor; görev kapsamındaki çalıştırma sırası içinde yer almadı, sonuç "geçti" sayılmadı |

**En önemli dürüstlük notu:** `npm run llm:doctor` (kısa yanıt veya JSON) bu ortamda her iki kapı için de "yapılandırılmadı / bilinmiyor" döndürüyor. Yani **kısa doctor yanıtı sınıflandırmanın çalıştığını KANITLAMAZ**; çalışma kanıtı yalnızca uçtan uca senaryo testlerinden ve gerçek tarama gözlemlerinden gelir.

Yöntem: iki yeni "senaryo" seti yazıldı ve gerçek üretim koduyla koşturuldu; her senaryo için beklenen sonuç **önceden** yazıldı. Test iddiasını geçirmek için üretim davranışı değiştirilmedi; üretim değişiklikleri yalnızca **bağımsız olarak doğrulanan bulgular** için yapıldı (bkz. G).

---

## B) Akış tablosu

| # | Aşama | Durum | Kanıt | Bulgu | Risk | Sonraki adım |
|---|---|---|---|---|---|---|
| 1 | Kaynak envanteri/adaptörler | Çalışıyor | `npm run sources:report` → 28 kayıt, 24 etkin, 15 geçmiş canlı doğrulama, 24 bayat | 8 kaynak canlı doğrulanmamış (sertifika/liste yapısı) | Orta (kapsam) | `docs/source-onboarding.md` ile kaynak doğrulama |
| 2 | HTTP + önbellek (ETag/304) + ağ güvenliği | Çalışıyor | `tests/fetcher.test.ts`, `guvenlik-url-siniri.test.ts`, `ingest.test.ts` (304 senaryosu) | Bulgu yok | Düşük | — |
| 3 | Ayrıştırma + sayfa iskeleti temizliği | Çalışıyor | `tests/html-chrome.test.ts`, `liste-gurultu-regresyon.test.ts`, yeni senaryo 4.1/2 | Bulgu yok (çerez modali ilan sayılmıyor) | Düşük | — |
| 4 | Normalizasyon + alan çıkarımı (kanıt zorunlu) | Çalışıyor | `tests/extraction.test.ts`, `city-extraction.test.ts`, `date-roles.test.ts` | Sözleşme öncesi (yayım < son başvuru) tarih düşürülüyor (bilinçli koruma) | Düşük | Kural kararı verilirse ayrı iş |
| 5 | Deterministik sınıflandırma | Çalışıyor | `tests/classification*.test.ts`, `eval:classification` (yalnız kurallar) | Gerçek veri etiketi yok | Orta | `npm run eval:build-set` |
| 6 | LLM kapısı (yalnız belirsiz kayıtlarda) | Çalışıyor | `tests/llm-gate.test.ts` + yeni 3.1–3.7 senaryoları (30 test) | `cacheHit` alanı merge yolunda `false` kalıyor | Düşük (gözlemlenebilirlik) | Raporda kayıtlı; davranış bozuk değil |
| 7 | Tekilleştirme + sürümleme | Çalışıyor | `tests/ingest.test.ts`, yeni senaryo 4.3/6 ve 4.3/9 | Bulgu yok | Düşük | — |
| 8 | Durum/tarih kuralları | Çalışıyor | Yeni senaryo 4.2/4 ve 4.2/5 | Süresi geçmiş ilan `closed`; tarih yoksa "açık" denmiyor | Düşük | — |
| 9 | Kayıt + inceleme kuyruğu | Çalışıyor | Yeni senaryo 4.1/3 (gövdesiz kayıt yayımlanmıyor, incelemeye düşüyor) | Bulgu yok | Düşük | — |
| 10 | Panel öneri asistanı | Çalışıyor | Yeni dosya `tests/senaryo-panel-oneri.test.ts` (17 test) | Uyum derecesi modelden geliyordu → **kod sınırı eklendi** | Orta → düşürüldü | — |
| 11 | Worker/zamanlayıcı | Çalışıyor | `tests/worker.test.ts` (16) + yeni 4 senaryo | Bakım kuyruğu tik başına 2 iş (tasarım) | Düşük | — |
| 12 | DB/RLS | **PostgreSQL ile test edilmedi** | `tests/postgres-*.test.ts` yalnız yapılandırma/TLS seviyesinde | Gerçek RLS davranışı doğrulanamadı | Orta | Gerçek PG üzerinde ayrı doğrulama |
| 13 | AI log/telemetri | Çalışıyor | `tests/llm-telemetry.test.ts`, yeni 3.6 | Bulgu yok (anahtar sızmıyor) | Düşük | — |

---

## C) LLM sonuçları (iki kapı AYRI)

### C.1 Kaynak koddan doğrulanan yapı
- **Kapı 1 — sınıflandırma:** `LLM_CLASSIFIER_ENABLED` (varsayılan `0`), model `LLM_CLASSIFIER_MODEL` (boşsa `LLM_MODEL`), `src/ai/classifier.ts`. **Yalnızca** deterministik motorun kararı `review` olduğunda çağrılır; karar ilan kaydına değil inceleme kuyruğunun `llmOpinion` alanına yazılır.
- **Kapı 2 — panel öneri asistanı:** `AI_ASSISTANT_ENABLED` (varsayılan `0`), model `LLM_MODEL`, `AI_DAILY_LIMIT_PER_USER`, `src/ai/suggest.ts`.
- Ortak taşıyıcı ayarları: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_TIMEOUT_MS`, `LLM_MAX_CALLS_PER_RUN`, `LLM_DAILY_CALL_LIMIT`, `LLM_MAX_CONCURRENCY`, `LLM_RETRY_MAX`. Taşıyıcılar: `openai-compat` ve `gemini-native` (`src/ai/llm.ts`).
- **İki kapı ayrı anahtarlarla ayrı test edildi** (aynı fixture'la birlikte karıştırılmadı): kapı 1 için `tests/llm-gate.test.ts` + `tests/senaryo-siniflandirma-ai.test.ts`; kapı 2 için `tests/ai-suggestions.test.ts` + `tests/senaryo-panel-oneri.test.ts`.

### C.2 Test edilen ve doğrulanan davranışlar (sahte sağlayıcı)
| Davranış | Sonuç |
|---|---|
| HTTP 429 → sınırlı yeniden deneme, sonra hata | ✔ (senaryo 14a/14d) |
| HTTP 503 ile **zaman aşımı AYRI** raporlanıyor | ✔ (senaryo 14b: `Sağlayıcı HTTP 503 döndü`, `Sağlayıcıya ulaşılamadı: Zaman aşımı`) |
| Boş içerik / bozuk JSON / şema dışı alan | ✔ hata olarak telemetriye yazılıyor, ham içerik saklanmıyor |
| Kanıt kaynakta birebir değilse kabul yok | ✔ (senaryo 12) |
| Prompt injection | ✔ kanıt/karar uygulanmıyor |
| Anahtar sızıntısı | ✔ hata metni `redactSecret` + 300 karakter; loglarda ve kayıtlarda anahtar yok (`not.toContain(API_KEY)`) |
| Önbellek | ✔ aynı içerik ikinci kez model çağrısı üretmiyor (çağrı 0, isabet 1) |
| Günlük kota | ✔ kota dolunca çağrı yapılmıyor; kalan hak doğru bildiriliyor |
| Maliyet | ✔ fiyat tanımlı değilse `null` (uydurma yok) |

### C.3 Test edilemeyen
- **Gerçek Gemini/OpenAI çağrısı:** anahtar yok. Bu yüzden "iki kapı gerçek sağlayıcıyla çalıştı" İDDİA EDİLMİYOR; yalnızca taşıyıcı sözleşmesi mock sunucu + sahte fetch ile doğrulandı.

### C.4 Bulgu (düzeltilmedi, kayıtlı)
- `classification.llm.cacheHit`, **merge** yolunda önbellekten dönüldüğü hâlde `false` kalıyor. Çalışma özeti (`gate.summary()`) ve telemetri (`llmAnalyses`) doğru. Etki: yalnızca gözlemlenebilirlik/teşhis (P3). Karar doğruluğu etkilenmiyor → davranış değiştirilmedi.

---

## D) İlan doğruluğu

### D.1 Sınıflandırma senaryoları (15 senaryo → 30 test, `tests/senaryo-siniflandirma-ai.test.ts`)
| # | Senaryo | Beklenen | Sonuç |
|---|---|---|---|
| 1 | Geçerli kamu personeli ilanı | review → kanıtlı kabul, `llmVerified` | ✔ |
| 2 | Tarih belirtilmiş ilan | tarih kaynaktan; model tarihi değiştiremez | ✔ |
| 3 | Tarih yok | `applicationEndDate` boş, durum "açık" DENMEZ | ✔ |
| 4 | Süresi geçmiş | `closed`, kayıt silinmez | ✔ |
| 5 | İçeriği değişmiş ilan | güncelleme + sürüm, kopya yok | ✔ |
| 6 | Aynı ilan farklı URL | tek kayıt | ✔ |
| 7 | Haber/duyuru | kanıtlı ret, ilan oluşmaz | ✔ |
| 8 | Çerez/onay modalı | ilan sayılmaz | ✔ |
| 9a/9b | Boş-bozuk kaynak yanıtı | uydurma yok; kayıt incelemeye düşer | ✔ |
| 10 | JSON yerine açıklama | review kalır; ham metin kayda yazılmaz | ✔ |
| 11 | Eksik alan/hatalı tip/geçersiz JSON | review kalır; yapı özeti telemetride | ✔ |
| 12 | Prompt injection | kanıt/karar uygulanmaz | ✔ |
| 13 | Kaynakta olmayan kurum/unvan/kontenjan/tarih | **DEPOYA YAZILMAZ** | ✔ (düzeltme sonrası) |
| 14a–d | 429 / 503 / zaman aşımı / sınırlı retry | ayrışan hata türleri, sınırlı deneme | ✔ |
| 15 | Aynı işin tekrarı | idempotent: ek API çağrısı ve kopya yok | ✔ |
| 3.7 | Model özetinde kanıtlanamayan sayı/tarih | etiketlenir veya kayda alınmaz | ✔ (yeni) |

### D.2 Toplama/kayıt akışı senaryoları (`tests/senaryo-toplama-akisi.test.ts`)
Erişilemeyen kaynakta **uydurma ilan yok** ve hata türü (`unavailable`/`structure`) kayıtlı ✔ · çerez modalı ilan sayılmıyor ✔ · **başlık/bağlantı tek başına kanıt değil** (gövdesiz kayıt yayımlanmıyor, incelemeye düşüyor) ✔ · süresi geçmiş ilan `closed` ve **öneri havuzuna girmiyor** ✔ · tarih yoksa "Başvuru açık" denmiyor ✔ · ikinci kaynakta yayımlanan aynı ilan tek kayda birleşiyor ve **özgün başvuru bağlantısı korunuyor** ✔ · AI sağlayıcı hatası ilan kaydını bozmuyor, hata insan incelemesinde görünüyor ✔ · kayıt bazlı hata taramayı durdurmuyor, loglarda `sourceKey` + `stage` var ✔ · aynı tarama tekrarlanınca kopya oluşmuyor ✔.

### D.3 Doğrulanan koruyucu davranış
Sözleşme dışı tarih (son başvuru, yayım tarihinden **önce**) kayda hiç yazılmıyor: kayıt `applicationEndDate: null`, durum `Durum belirsiz`. Yanlış "Başvuru açık"/"Başvuru kapandı" iddiası üretilmiyor (bilinçli koruma; kanıt: `.probe8` ölçümü, senaryo 4.2/5).

### D.4 Gerçek doğruluk iddiası
`npm run eval:classification`: 17 kayıt, **0 gerçek/insan doğrulamalı**; yanlış kabul %0 ve yanlış ret %0 oranları **yalnız sentetik** olduğu için gerçek doğruluk sayılmaz. Araç bunu kendisi uyarı olarak yazıyor.

---

## E) Worker ve zamanlayıcı

- **Başlatma:** `npm run dev` (API + worker + web), `npm run dev:worker`, üretimde `npm run start:worker`. Bu denetimde **worker çalıştırılmadı** (gereksiz çalıştırma yapılmadı, gerçek kaynak taranmadı).
- **Görev türleri:** `source-scrape` + sistem görevleri `deadline-refresh` (30 dk), `maintenance` (60 dk), `coverage-audit`. Yeni senaryo 6/1: dört türün **hepsi** için işleyici var; "bilinmeyen bakım görevi" uyarısı üretilmiyor; kuyrukta `failed`/`dead` iş kalmıyor.
- **Kuyruk:** `builtin` (dosya/DB) ve `redis` arka uçları; dedupe anahtarı sayesinde aynı zamanlanmış çalışma iki kez kuyruğa girmiyor; başarısız tarama üstel geri çekilmeyle yeniden deneniyor, sınır dolunca **DLQ**.
- **Eşzamanlı çift çalışma / kilit süresi:** yeni senaryo 6/2 — kilit süresi dolmadan ikinci worker alamıyor, yanlış sahip uzatamıyor, süre dolunca devralınabiliyor (tek kilit kalıyor).
- **Güvenli sonlanma:** yeni senaryo 6/4 — `requestStop()` sonrası döngü kapanıyor, kalp atışı `stopped`, `scrape:` kilitleri bırakılmış. Ayrıca süreç ölürse yarım `running` tarama kayıtları "stale" olarak kapatılıyor (`tests/stale-runs.test.ts`, `worker.test.ts`).
- **Yeniden başlatmada görev kaybı:** görev durumu veritabanında tutulduğu için worker yeniden başladığında kalan iş sürdürülüyor (mevcut test + senaryo 6/3: scheduler kapalıyken due görev kuyruğa alınmıyor, zaman çizelgesi kaymıyor).
- **Gemini hatasında retry sınırları:** `LLM_RETRY_MAX` (varsayılan **1** ek deneme, şema üst sınırı **3**; `src/config/env.ts:338`) + `MAX_RETRY_AFTER_MS = 10_000` (`src/ai/llm.ts:107`); 429/503'te deneme sınırlı, sonsuz döngü yok (senaryo 14).
- **E-posta:** sağlayıcı anahtarı yoksa **dosyaya** yazılıyor (`data/mail`), üretimde anahtarsız başlatma hata veriyor (`src/email/transport.ts`, `tests/email.test.ts`, `tests/resend-transport.test.ts`) → dev'de gerçek e-posta kapalı.
- **Not (tasarım):** bakım kuyruğu tik başına en çok **2** iş çekiyor; birikmiş sistem görevleri birkaç tikte eritiliyor (senaryo 6/1 bu yüzden iki tik koşuyor).

---

## F) Testler — komut komut gerçek sonuç

| Komut | Sonuç | Not |
|---|---|---|
| `npx vitest run` (**başlangıç, kod değişikliğinden önce**) | **88 dosya / 1135 test PASS**, 118.96 s | Baseline kaydı |
| `npm run typecheck` (`tsc --noEmit`) | **Temiz** | Son durumda hata yok |
| `npm run lint` (`eslint .`) | **Temiz** (0 hata/0 uyarı) | Probe dosyaları silindikten sonra |
| `npm run build` (`tsc --noEmit && vite build`) | **Başarılı** (113 modül, ~0.33 s) | Üretim derlemesi |
| `npx vitest run` (**son durum**) | **92 dosya / 1196 test PASS**, 121.5 s | +4 dosya, +61 test |
| `npx vitest run tests/senaryo-siniflandirma-ai.test.ts` | 30 PASS | Yeni |
| `npx vitest run tests/senaryo-panel-oneri.test.ts` | 17 PASS | Yeni |
| `npx vitest run tests/senaryo-toplama-akisi.test.ts` | 10 PASS | Yeni |
| `npx vitest run tests/senaryo-worker-zamanlayici.test.ts` | 4 PASS | Yeni |
| `npm run llm:doctor -- --json` | Çalıştı; iki kapı "yapılandırılmadı", denetimler "bilinmiyor" | Canlı çağrı yapılmadı |
| `npm run env:check` | Çalıştı; e-posta dosya, AI kapalı, DB dosya | Sır yazdırılmadı |
| `npm run sources:report` | Çalıştı; 28 kayıt, 24 etkin, 8 canlı doğrulanmamış | Ağa çıkılmadı |
| `npm run eval:classification` | Çalıştı; "VERİ YETERSİZ" uyarısı | Gerçek doğruluk iddiası yok |

**Çalıştırılmayan / engellenen testler (gerekçeli):**
- `npm run test:e2e` (Playwright) — canlı sunucu + tarayıcı gerektiriyor; sonuç "geçti" sayılmadı.
- `npm run test:live` (gerçek kaynak) — canlı taranmama talimatı nedeniyle çalıştırılmadı.
- Gerçek Gemini/OpenAI çağrısı, gerçek SMTP/Resend gönderimi, gerçek PostgreSQL+RLS — ortam/anahtar yok.

---

## G) Yapılan değişiklikler (kanıt → kök neden → dosya → test → uyumluluk)

### G.1 Model özeti kaynakla doğrulanmadan ilan kaydına yazılıyordu (P1)
- **Kanıt:** Senaryo 13 ölçümü: kaynakta olmayan "150 kişi" ve "01.12.2026" ifadeleri model özeti olarak kayda geçiyordu; kayıt herkese açık uçtan okunuyor.
- **Kök neden:** `output.ozet` (serbest metin) doğrulama olmadan `classification.reasons` ve `negativeSignals` içine yazılıyordu; kanıt doğrulaması yalnız `kanitlar` alanı için yapılıyordu.
- **Değişiklik:** `src/ai/classifier.ts` → `looseDateKeys`, `unbackedSummaryFacts`, `modelSummaryForRecord`; `applyVerdict` artık kaynak metni (`haystack`) alıyor; özet kaynakta bulunmayan sayı/tarih içeriyorsa **kayda hiç yazılmıyor**, aksi halde `doğrulanmamış model özeti: …` etiketiyle yazılıyor.
- **Test:** `tests/senaryo-siniflandirma-ai.test.ts` → 3.7 bloğu (4 test) + senaryo 13 iddiası; 30 test PASS.
- **Uyumluluk:** Şema/alan değişmedi, yalnız metin içeriği değişti; "uyum sağlayıcı" (backward-compatible).

### G.2 Süresi geçmiş ilan önerilebiliyordu (P1)
- **Kanıt:** `selectCandidates` yalnız `status` alanına güveniyordu; bu alan `deadline-refresh` görevine kadar bayat kalabiliyor.
- **Değişiklik:** `src/ai/candidates.ts` → başvuru penceresi `computeStatus` ile **yeniden hesaplanıyor**; `active`/`upcoming` değilse aday değil.
- **Test:** `tests/senaryo-panel-oneri.test.ts` → "durum alanı bayat olsa bile süresi geçmiş ilan aday havuzuna girmez" (PASS).
- **Uyumluluk:** Ek filtre; geçerli ilanlar etkilenmiyor (tüm öneri testleri PASS).

### G.3 Uygunluk derecesi modele devrediliyordu (P1)
- **Kanıt:** Kod uygunluğu hesaplıyor (`src/lib/profile-match.ts`) ama gösterilen "güçlü/olası/zayıf" derecesi koşulsuz modelden geliyordu; model, kural motorunun "uyuşmuyor" dediği ilan için "güçlü" yazabiliyordu.
- **Değişiklik:** `src/ai/suggest.ts` → `capFitBySignal` (model, deterministik sinyalin üstüne çıkamaz; aşağı inebilir), kural gerekçe/uyarıları model listesine **her zaman** ekleniyor, sağlayıcı yokken kalan hak `rateLimits.peek` ile doğru raporlanıyor.
- **Test:** `tests/senaryo-panel-oneri.test.ts` (senaryo 2, 6, `capFitBySignal` birim testi) PASS; `tests/ai-suggestions.test.ts` beklentisi **bilinçli olarak** güncellendi (`strong` → `possible` + "sınırlandırıldı" uyarısı) — bu bir davranış değişikliğidir ve ilgili testte gerekçesi yazılıdır.
- **Uyumluluk:** API şeması aynı; kullanıcıya gösterilen derece artık **daha muhafazakâr**. Etki: AI kartı bazı ilanlarda "Güçlü uyum" yerine "Olası uyum" gösterir (istenen davranış).

### G.4 İşleme hatası loglarında kaynak/aşama yoktu (P3)
- **Değişiklik:** `src/ingest/pipeline.ts` → kayıt bazlı hata loguna `sourceKey` + `stage: 'item'`, adaptör hatası loguna `stage: 'adapter'` + `errorType` eklendi.
- **Test:** `tests/senaryo-toplama-akisi.test.ts` senaryo 8 (log alanları doğrulanıyor) PASS.

### G.5 Yeni test dosyaları
`tests/senaryo-siniflandirma-ai.test.ts` (30) · `tests/senaryo-panel-oneri.test.ts` (17) · `tests/senaryo-toplama-akisi.test.ts` (10) · `tests/senaryo-worker-zamanlayici.test.ts` (4) · değiştirilen: `tests/ai-suggestions.test.ts` (beklenti gerekçeli güncellendi).

**Değişen üretim dosyaları:** `src/ai/classifier.ts`, `src/ai/candidates.ts`, `src/ai/suggest.ts`, `src/ingest/pipeline.ts`.
**Dokunulmayanlar:** şema/migration, API sözleşmeleri, arayüz bileşenleri, `.env*`, `package.json`, gerçek veri.

### G.6 (ek tur, commit `2b03d4c`) Saklı verideki üç tarih hatası onarılamıyordu (P1)
- **Kanıt:** Kullanıcının kendi kuru çalıştırma raporu (16.10.2026 08:56Z): `applicationEndDate = 1991-01-01` (Savunma Sanayii, Özelleştirme), `applicationEndDate = 2025-12-20` + `publishedAt = 2026-10-12` (Adalet ×3), ayrıca `tani:ilan` raporunda 8 kayıt 2004/2008/2013/2018/2019 yayım tarihiyle görünüyordu.
- **Kök neden (kaynak koddan):**
  1. `scripts/reclassify-jobs.ts` → `buildReport` kayıttaki **ham** `publishedAt`/`applicationEndDate` alanını yazdırıyordu; `reclassifyJob`'un yazacağı değer raporda **hiç görünmüyordu** → "kapı çalışmıyor" izlenimi.
  2. `reclassifyJob` tarihleri onarıyordu ama **"desteksiz tarih" kararı yoktu**: yasaldan okunmuş eski yayım tarihi yalnızca gelecek tarih olduğunda siliniyordu, 2004/2013 tarihleri kayıtta kalıyordu.
  3. `plausibleApplicationEnd` (2000 alt sınırı + yayımdan önce olamaz) yalnızca **yeni** çıkarımlarda çalışıyordu; hatanın oluştuğu anda kayda yazılmış değer geriye dönük temizlenemiyordu.
- **Değişiklik:**
  - `src/ingest/reclassify.ts` → `PUBLISHED_DATE_REGRESSION_DAYS` (400) + `UNSUPPORTED_PUBLISHED_DATE_NOTE`; yayım tarihi **gövdeden türetilmişse** (`fieldSources.publishedAt.kind !== 'listing'`), güncel `extractPublishedAt` kayıttaki metinde tarih bulamıyorsa ve tarih ilk görülmeden 400+ gün önceyse tarih **kaldırılır** ve `uncertainties` alanına gerekçe eklenir. Liste katmanından gelen tarih (kaynağın kendi listesi) sorgulanmaz.
  - `src/ingest/reclassify-batch.ts` → özet sayaçları `publishedAtCleared`, `applicationEndCleared`; rapor satırına `publishedAtAfter` ve `applicationEndDateAfter` (ham değer ile **yazılacak** değer bir arada).
  - `scripts/reclassify-jobs.ts` → kuru çalıştırmada silinecek tarih sayıları görünür.
  - `src/domain/text.ts` → `UI_CHROME_PHRASES` canlı koşumda gövdeye yapıştığı görülen erişilebilirlik çubuğu ve çerez dizeleriyle genişletildi (depodaki canlı çıktı kayıtlarından alındı; "Kontrast", "Filtrele" gibi genel kelimeler bilinçli olarak dışarıda).
  - `src/config/app.ts` → `EXTRACTION_VERSION` `2026.10.3`.
- **Test:** `tests/yeniden-siniflandirma-tarih.test.ts` (17 test): Göç 2013 / AFAD 2004 yasaldan okumuş tarihleri temizlenir, 2026-10-14 tarihli gerçek tarih korunur, YÖK 2026-04-20 (pencere içi) korunur, liste tarihi korunur, gelecek tarih reddi sürer; 1991 ve yayım-öncesi bitiş tarihleri temizlenir, geçerli bitiş korunur; kabuk temizliği; boş yamada yazma yok; özet sayaçları; raporun ham/sonrası değerleri.
- **Uyumluluk:** Yeni veri yazımı yok, yalnız var olan kayıtlar yeniden sınıflandırıldığında onarılır. Geri dönüş: `npm run jobs:restore -- <yedek>` (yedek `--apply` öncesi otomatik alınır). Yan etki: yayım tarihi silinen kayıtlar için son başvuru kapısı yalnızca 2000 alt sınırını uygular (test ile sabitlendi, bilinçli sınır).
- **Doğrulama:** tam süit **95 dosya / 1231 test PASS**; `npm run typecheck`, `npm run lint`, `npm run build` temiz.

---

## H) Sonraki adımlar (teknik bilgisi sınırlı kullanıcı için, sırayla)

1. **Kodu al ve hazırla:** proje klasöründe `git pull` → `npm ci`.
2. **Bilgisayarında kontrol et:** `npm run env:check` çalıştır. Çıktıda "email: dosya (geliştirme; e-posta gönderilmez)" yazmalı. Gerçek kaynaklara çıkmak İSTEMİYORSAN `.env` dosyanda `SOURCE_LIVE_FETCH=0` yap.
3. **Sağlık kontrolü:** `npm test` (hepsi geçmeli) ve `npm run build` (hatasız bitmeli). Bu rapordaki sonuçlar: 1231 test PASS, derleme başarılı.
3b. **Veriyi onar (ÖNCE kuru çalıştırma):**
   ```
   npm run jobs:reclassify -- --report raporlar\reclassify-kuru.json
   ```
   Çıktıda şu iki satırı oku: "Desteksiz yayım tarihi silinecek" ve "İmkânsız son başvuru silinecek". Sayılar makul görünüyorsa (bu denetimde beklenen: yayım tarihi ≈ 8 kayıt, son başvuru ≈ 5 kayıt) ve **hiçbir kayıt silinmiyor**, aşağıdaki komutla uygula:
   ```
   npm run jobs:reclassify -- --apply
   ```
   Bu komut önce `data/backups/` altına **tam yedek** yazar. Beğenmezsen geri dönüş: `npm run jobs:restore -- data\backups\jobs-before-reclassify-<tarih>.json` (önce aynı komutu `--apply` olmadan çalıştırıp önizlemek de mümkündür).
4. **Yapay zekâyı AÇMADAN doğrula:** `npm run llm:doctor` — kapıların "kapalı" göründüğünü gör. Bu yanıt **sınıflandırmanın çalıştığını göstermez**; yalnız "hazır değil" bilgisidir.
5. **Gerçek Gemini'yi dene (isteğe bağlı, ücretli olabilir):** `.env` içinde `AI_ASSISTANT_ENABLED=1`, `LLM_CLASSIFIER_ENABLED=1`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`. Sonra **yine `npm run llm:doctor`** çalıştır ve **iki kapının ayrı ayrı** yeşil olduğunu gör (kapı 1: sınıflandırma, kapı 2: panel asistanı). Doctor tek başına yeterli değildir; bir sonraki adımda gerçek senaryoyu dene.
6. **Tek kaynakla sınırlı deneme:** panelden **tek bir kaynağı** elle tara (Kaynaklar sayfası), ardından **İnceleme kuyruğu** ve **Kaynak sağlığı** ekranlarını kontrol et. Birden çok kaynağı aynı anda taramayın.
7. **Panelde sırayla bak:** (a) incelenmeyi bekleyen kayıtlar, (b) kaynak sağlığı/hata türleri (`unavailable`/`structure`/`fetch`/`item`), (c) LLM telemetrisi (çağrı/önbellek/hata sayıları), (d) öneri asistanı kartı (uyum derecesi artık kural sinyaliyle sınırlı).
8. **Maliyet ölçümü istersen:** `LLM_COST_USD_PER_MTOK_INPUT` ve `LLM_COST_USD_PER_MTOK_OUTPUT` değerlerini kendi faturalandırmanla gir; boş bırakılırsa sistem maliyet raporlamaz (bu doğru davranıştır).
9. **Gerçek PostgreSQL/RLS doğrulaması:** üretim veritabanında **silme/güncelleme** yapmadan, ayrı bir test veritabanında `npm run db:migrate` + uygulamayı çalıştırıp RLS denetimini yap (bu rapor kapsamında yapılmadı).
10. **Bilinen takip işleri:** (a) `cacheHit` alanının merge yolunda `true` olması (P3 gözlemlenebilirlik), (b) `disi/epdk/kgm/saglik-bakanligi` gibi 8 kaynağın canlı doğrulaması, (c) `npm run eval:build-set` ile **insan doğrulamalı gerçek kayıt** etiketlemesi (gerçek doğruluk ancak o zaman ölçülebilir).

---

### Ek: Bu denetimde YAPILMAYANLAR (yanlış anlaşılmasın diye açıkça)
- Gerçek kaynak taraması ve gerçek LLM çağrısı yapılmadı; üretim veritabanına hiç yazılmadı/silinmedi; migration çalıştırılmadı.
- Gerçek e-posta, Telegram veya başka dış bildirim gönderilmedi.
- Kişisel veri içeren hiçbir gerçek profil AI'ya gönderilmedi; testlerde kullanılan profil/e-posta değerleri uydurma test verisidir.
- Kapatılan test iddiası yok: AI uyum derecesi sınırlaması dışında hiçbir mevcut test beklentisi değiştirilmedi (o değişiklik de gerekçesiyle belgelendi).
