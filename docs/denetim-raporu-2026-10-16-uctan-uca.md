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

### C.5 Kullanıcının gördüğü "Sağlayıcı HTTP 404" — kök neden KANITLANDI ve zaten düzeltildi
- **Kullanıcı kanıtı (üretim Supabase, `tani:ilan` bölüm 8):** 2 analiz / 2 API çağrısı / 2 hata (%100), gecikme 324 ms ve 367 ms, **token 0**, maskeli metin: `Sağlayıcı HTTP 404 döndü.` (çağrılar 16.10.2026 00:06 ve 00:08, Türkiye saati).
- **Kök neden (kaynak koddan + depo içi tutanak):** İstemci `${LLM_BASE_URL}/chat/completions` adresine gidiyordu. Google kökü verildiğinde bu adres `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` oluyordu; Google'ın OpenAI uyumluluk kabuğu bu yolu her anahtar/model için sunmuyor → **404**. Aynı anahtarla `/v1beta/openai/models` **200** döndüğü için `llm:doctor` "hazır" görünüyordu (63 model listelendi) — bu yüzden 404 teşhis edilemiyordu.
- **Kanıt izi (tahmin değil):** `src/ai/llm.ts` başlığı olayı ve kanıtını yazıyor; `tests/llm-uc-nokta.test.ts` başlığı "2026-10-16 canlı panel: … Sağlayıcı HTTP 404 döndü, LLM ölçümleri %100 hata · 0 token. Kök neden yapılandırmaydı" diyor; `src/config/env.ts` (LLM kapısı uyarısı) aynı panel sayılarını anıyor.
- **Durum: DÜZELTİLDİ (bu denyimde ek iş yok).** Düzeltme `main` dalında **`a777f38`** (16.10.2026 03:14 +03) ile geldi: Google kökü artık birincil (yerel) API'yi kullanır → `POST {kök}/v1beta/models/{model}:generateContent`, anahtar `x-goog-api-key`. Kullanıcının çağrıları bu düzeltmeden **~3 saat önce** yapılmıştı. `resolveLlmEndpoint` + `googleApiVersionPath` (`/v1beta/openai` → `/v1beta` indirgenir) + `normalizeGeminiModel` (`models/` öneki atılır) kodda doğrulandı; sınıflandırma kapısı da, `llm:doctor` da **aynı** `callChatCompletion` yolunu kullanıyor.
- **Kalan tek koşul:** kullanıcının kendi kopyası güncel olmalı (`git pull`) ve `LLM_BASE_URL` Google kökünü göstermeli. Doğrulama: `npm run llm:doctor` → taşıyıcı `gemini-native`, HTTP 200, model listede, kullanılabilir metin üretildi. Bu adım **1 gerçek çağrı** yapar (kullanıcı onaylı sınır: ≤5 çağrı).
- **Not:** `LLM_COST_USD_PER_MTOK_*` boş olduğu için bu çağrıların maliyeti **doğrulanmış sayılmaz** (fiyat uydurulmadı).

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
| `npx vitest run` (ilk tur sonu) | **92 dosya / 1196 test PASS**, 121.5 s | +4 dosya, +61 test |
| `npx vitest run` (**son durum, 16.10.2026**) | **96 dosya / 1245 test PASS**, 116.1 s | +8 dosya, +110 test (baseline'a göre) |
| `npx vitest run tests/govde-iskelet-olcumu.test.ts` | 10 PASS | Yeni: gövde iskelet ölçümü |
| `npx vitest run tests/yeniden-siniflandirma-tarih.test.ts` | 21 PASS | 17 tarih/rapor + 4 kabuk temizliği |
| `npm run tani:ilan -- --kaynak …` (sentetik dosya deposu) | Çalıştı; 9. bölüm + `sourceReview` + T12 doğru | Gerçek veri yazılmadı |
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
### G.7 (ek tur, commit `ab240e5`) Kabuk temizliği kullanıcının gerçek gövde metinleriyle genişletildi (P1)
- **Kanıt:** Kullanıcının kuru çalıştırma raporundaki (16.10.2026, Supabase) kayıtların `excerpt` alanları:
  - Karayolları (`kgm-duyurular`, 4 kayıt): "Daha yüksek erişilebilirlik modunu aç … Şerit Komutlarını Atla … Şu anda seçili DuyuruDetay ANA SAYFA KURUMSAL …"
  - DSİ (`dsi-duyurular`, 2 kayıt): "HızlıErişim Anasayfa Tarım ve Orman Bakanlığı …"
  - İŞKUR (`iskur-*`, 3 kayıt): "Erişilebilirlik Menüsü … Kontrast Solgunlaştırma Düşük Doygunluk … Erişilebilirlik Ayarlarını Temizle … Kabul Ediyorum … Zorunlu Çerezler"
  - İçişleri (menü başlıklı kayıt): "Tarih aralığı seçiniz Başlangıç tarihi seçiniz … Bitiş tarihi seçiniz"
- **Kök neden:** `UI_CHROME_PHRASES` bu dizeleri içermiyordu; `stripUiChrome` yalnızca tanıdığı ifadeleri siliyor, kalan menü/çerez metni gövde olarak kalıyordu. Alan çıkarımı (şehir, son tarih, kadro) bu metinde kanıt bulamıyor → bu kayıtlarda `status: unknown`, alanlar boş.
- **Değişiklik:** `src/domain/text.ts` → liste kayıtlardan birebir dizelerle genişletildi (genel kelimeler "Kontrast", "Filtrele", "temizle" hariç). Temizlik hem yeni çıkarımda hem yeniden sınıflandırmada uygulanır.
- **Test:** `tests/yeniden-siniflandirma-tarih.test.ts` → 4 test: Karayolları/İŞKUR/DSİ/İçişleri metinleri temizlenir, gerçek ilan içeriği korunur.
- **Not (16.10.2026 güncellemesi — bkz. G.8):** canlı örnek geldi. Kullanıcının üretim verisindeki 4 kaynakta (DSİ 2/2, Karayolları 4/4, TMSF 3/3, İŞKUR 1/1 = 10 kayıt) gövde metninin tamamı menü/çerez/erişilebilirlik iskeleti; gerçek ilan cümlesi ancak 2500 karakterlik kesitin **sonrasında** başlıyor. Bu kayıtların alan çıkarımı gövdeye dayanamaz. Gövde seçici düzeltmesi hâlâ yapılmadı: hangi kapsayıcının doğru olduğunu söylemek için **kaynağın canlı HTML'i** (DevTools'tan kopyalanmış) gerekiyor.

### G.8 (commit `d70a8d3`) Tek kaynağın gerçek kayıtlarını tam gövde metniyle inceleme (`tani:ilan --kaynak`)
- **Neden:** "gövde menü mü, ilan mı?" sorusu yalnız 2500 karakterlik kesitle değil, tam metinle yanıtlanabilmeliydi.
- **Değişiklik:** `scripts/tani-ilan-kalitesi.ts` → `--kaynak <anahtar>` ve `--kaynak-sayi <n>` (varsayılan 10). 9. bölüm her kayıt için kimlik/başlık/kurum/karar-tür/durum/yayım(+kaynağı)/son başvuru/ilan+başvuru adresi/ilk-son görülme/**tam gövde** yazar; JSON çıktısına `sourceReview` eklenir. **Salt okuma.**
- **Doğrulama (sentetik depo):** `DATABASE_DRIVER=file DATA_DIR=/tmp/tani-data5 … --kaynak dsi-duyurular --json /tmp/tani5.json` → 9. bölüm ve `sourceReview` doğru; probe ve geçici dosyalar silindi.

### G.9 (bu tur) Gövde metni iskelet ölçümü + gerçek kaynak incelemesi kanıtı
- **Kullanıcı kanıtı (üretim Supabase, `--kaynak` çıktıları; uzunluklar 2499–2500 karakter = kesit sınırı):**
  - **DSİ (2 kayıt):** `…cf2ff2cd…` "PERSONEL DAİRESİ BAŞKANLIĞI" (yayım 2018-07-10, `detail`, kapalı) ve `…76dfaa3f…` "ARAZİ TOPLULAŞTIRMASI … DAİRESİ BAŞKANLIĞI" (bitiş 2026-10-23, aktif, adres `dsi.gov.tr/duyuru/duyuruListe` = **liste sayfası**). Gövdelerin %100'ü menü.
  - **Karayolları (4 kayıt):** biri kabuk başlıklı ("Daha yüksek erişilebilirlik modunu aç"), adresi `Duyurular.aspx` (liste sayfası); diğer üçü (50 işçi noter kurası, 50 işçi personel alımı, Erzurum 1 engelli işçi) gerçek ilan metni içeriyor ama metin menüden **sonra** başlıyor ve 2500 karakterlik kesitte yarıda kalıyor.
  - **TMSF (3 kayıt):** üçünün gövdesi birebir aynı menü ("Mevduat Sigortacılığı … Kayyımlık …"); detay içeriği hiç alınamıyor. (Biri "TMSF Personel Alım İlanı 2026", yayım tarihi `listing` kaynaklı 2026-10-12.)
  - **İŞKUR (1 kayıt):** adres `iskur.gov.tr/ilanlar/kurumdisi-kamu-isci-alim-ilanlari` (liste sayfası), gövde çerez + menü.
- **Sonuç:** 10 kayıt için karar ve alan çıkarımı gövdeye **dayanamaz**; bu kayıtların "şehir/kadro/son tarih yok, durum bilinmiyor" görünmesinin nedeni budur. KGM kayıtlarının adresi kaynağın **liste** sayfası olduğundan `isSourceListingUrl` (`599e097`) bu kayıtları reddeder; DSİ `…76dfaa3f…` için de aynı sonuç geçerli — "olası yanlış ret" endişesi bu adresle büyük ölçüde kalkar (nihai karar kullanıcıda, **kayıt silinmez**).
- **Ölçüm aracı (yeni, yalnız ölçüm — toplama davranışını DEĞİŞTİRMEZ):** `src/domain/text.ts` → `looksLikePageChromeText` + `pageChromeShare` + `PAGE_CHROME_SHARE_THRESHOLD = 0.15` + `PAGE_CHROME_NAV_TERMS`. Kural: metin ≥300 karakter, **ilan cümlesi kalıbı yok** (`alınacaktır`, `son başvuru`, `kadro`…) ve bilinen arayüz/menü ifadelerinin payı ≥ %15 ise "gövde iskelet" sayılır.
- **Kalibrasyon (ölçülen paylar):** menü dökümleri 0,18–0,54; gerçek ilan metinleri 0,00–0,03 → ayrım boşluğu ~6 kat. Testler: `tests/govde-iskelet-olcumu.test.ts` (10 test: 4 pozitif, 4 negatif, ayrım boşluğu, kısa metin kuralı). Kaynak sınırlaması dürüstçe: pozitif metinler kullanıcının **panele yapıştırdığı** kayıt gövdelerinden yeniden kuruldu; birebir 2499 karakterlik gövdeler `--kaynak --json` çıktısıyla yeniden doğrulanmalı.
- **Tanı entegrasyonu:** `tani:ilan` bölüm 3'e **T12** bulgusu eklendi — "gövde metni sayfa iskeleti (menü/çerez) — alan çıkarımı gövdeye dayanamaz". Sentetik depoyla doğrulandı: iskelet gövde işaretlendi (pay 1,00), gerçek ilan gövdesi işaretlenmedi.
- **Yapılmayan (gerekçeli):** gövde **seçici** düzeltmesi yapılmadı. Hangi kapsayıcının alınacağını belirlemek kaynağın canlı HTML'ini gerektirir; canlı HTML örneği olmadan kural eklemek "kanıtsız kural" olurdu.

- **Doğrulama:** tam süit **97 dosya / 1252 test PASS**; `npm run typecheck`, `npm run lint`, `npm run build` temiz.

### G.10 (bu tur) İki kanıtlı düzeltme daha: gövde seçimi gerçek kayıtlarla + DSİ kararı + 404 sinyali
- **Kullanıcı kanıtı (`tani:ilan --kaynak dsi-duyurular`, üretim Supabase, 16.10.2026 09:45Z):**
  - `job_cf2ff2cd9f534750a64987cf` → kayıt adresi `https://dsi.gov.tr/Sayfa/Detay/708`, gövde 100% menü ("HızlıErişim … DAİRESİ BAŞKANLIĞI … Personel Dairesi Başkanlığı Bağlı Şube Müdürlükleri…"). **Kurumsal birim sayfası; duyuru değil.**
  - `job_76dfaa3f21ee4021b2c79fa6` → kayıt adresi `https://dsi.gov.tr/duyuru/duyuruListe`; gövdenin sonunda "Anasayfa > Duyuru Arşivi / Tüm Duyurular Arşiv DSI SÖNDÖR BELGESİ SINAV İLANI 05.10.2026 …" görünüyor. **Bu adres kaynağın kendi `listingUrl`'i** (`src/config/sources.ts` → `dsi-duyurular.listingUrl = 'https://www.dsi.gov.tr/duyuru/duyuruListe'`): kayıt, arşiv liste sayfasıdır; "son başvuru 2026-10-23" ve "durum: aktif" listedeki tarihlerden geliyor.
  - **Karar:** İKİ KAYIT DA sayfa artığı → reddetmek DOĞRU, "olası yanlış ret" endişesi **kanıtla kapandı**. Ayrıca `599e097`'deki `isSourceListingUrl` filtresi bu adresi (`www` farkı ve son eğik çizgi normalize edilerek) gelecekte kayıt oluşmadan reddeder.
- **Gövde seçimi düzeltmesi (P1, `src/lib/html.ts`):** `readableAnnouncementText` seçici sırasındaki **ilk 80+ karakterlik** adayı kabul ediyordu; kurum sitelerinde bu aday menü kabı oluyor ve metnin tamamını menü dolduruyordu (Karayolları kaydında ilan cümlesi ancak ~2400. karakterde başlıyor ve 2500 karakterlik kesitte yarıda kalıyordu; TMSF/İŞKUR/DSİ'de gövde tümüyle menü). Artık metninin yarısından fazlası bağlantı (`<a>`) olan aday ilan gövdesi sayılmaz (`LINK_DENSE_CANDIDATE_SHARE = 0.5`); ayrıca T12 ölçümü de aday seçiminde kullanılır. Sayfa tümüyle menüyse **en az bağlantı yoğun** adaya düşülür — kayıt boş kalmaz, davranış eskisinden kötü olmaz.
- **Test:** `tests/govde-secimi-menu-regresyon.test.ts` (7 test): Karayolları yapısı (menü + `#DeltaPlaceHolderMain` ilan metni), TMSF/İŞKUR yapısı (`main` menüsü + `.icerik` ilanı), hızlı yol (ilk aday zaten ilan), tamamen menü sayfası, kısa duyuru, kabuk temizliği ve **eski kuralın menüyü seçtiğini gösteren hata kanıtı**. Menü metinleri kayıtlardan birebir alındı.
- **Sürüm:** `EXTRACTION_VERSION` `2026.10.3` → **`2026.10.4`** (gövde seçimi değişti; eski kayıtlar yeniden sınıflandırma/taramayla güncellenir).
- **Tanı düzeltmesi (`scripts/tani-ilan-kalitesi.ts`):** başarısız AI çağrılarının sinyal listesine **"404 (uç nokta/model yolu bulunamadı — yapılandırma)"** eklendi. Önceden 404 "sınıflandırılamayan" olarak görünüyordu; teşhis bu yüzden zorlaşmıştı. Sentetik depoyla doğrulandı (404 → yeni etiket, 429 → kota etiketi).
- **Kullanıcının kendi çalıştırdığı kuru çalıştırma (16.10.2026 09:30Z, üretim):** 67 kayıt; akışta kalan 38 (19 iş ilanı + 19 süreç duyurusu), akıştan çıkan 29, başlık temizlenen 1, durum değişen 7, tür değişen 13, toplam değişen 50, **bekleyen bildirim 0** (48 bildirim kaydı bastırıldı). Yayım tarihi düzeltmesi 8 kayıtta (2004×2 AFAD, 2008 Türk Patent, 2013 Göç İdaresi, 2018×3 DSİ/Batı Akdeniz/OKA, 2019 Hazine) ve imkânsız son başvuru 6+ kayıtta (Savunma Sanayii/Özelleştirme 01.01.1991, Adalet ×3 20.12.2025 < yayım 12.10.2026, MEB 14.09.2026 < yayım 22.09.2026) tetiklendi — hepsi yasal atıf/sayfa tarihi kaynaklı, kayıt silinmiyor yalnız tarih alanı `null` oluyor.

---

## H) Sonraki adımlar (teknik bilgisi sınırlı kullanıcı için, sırayla)

> **Kullanıcının sonraki TEK adımı:** aşağıdaki **3b** (kuru çalıştırma) + **3c** (uygula) kararı. Bunun dışındaki adımlar isteğe bağlıdır. Yapay zekâ kapısı 404 sorunu **zaten düzeltilmiş durumda** (bkz. C.5) — bunun için yeni kod gerekmiyor, yalnız `git pull` yeterli.

1. **Kodu al ve hazırla:** proje klasöründe `git pull` → `npm ci`.
2. **Bilgisayarında kontrol et:** `npm run env:check` çalıştır. Çıktıda "email: dosya (geliştirme; e-posta gönderilmez)" yazmalı. Gerçek kaynaklara çıkmak İSTEMİYORSAN `.env` dosyanda `SOURCE_LIVE_FETCH=0` yap.
3. **Sağlık kontrolü:** `npm test` (hepsi geçmeli) ve `npm run build` (hatasız bitmeli). Bu rapordaki sonuçlar: 1245 test PASS, derleme başarılı.
3b. **Veriyi onar (ÖNCE kuru çalıştırma):**
   ```
   npm run jobs:reclassify -- --report raporlar\reclassify-kuru.json
   ```
   Çıktıda şu iki satırı oku: "Desteksiz yayım tarihi silinecek" ve "İmkânsız son başvuru silinecek". Sayılar makul görünüyorsa (bu denetimde beklenen: yayım tarihi ≈ 8 kayıt, son başvuru ≈ 4–5 kayıt) ve **hiçbir kayıt silinmiyor**, aşağıdaki komutla uygula:
   ```
   npm run jobs:reclassify -- --apply
   ```
   Bu komut önce `data/backups/` altına **tam yedek** yazar. Beğenmezsen geri dönüş: `npm run jobs:restore -- data\backups\jobs-before-reclassify-<tarih>.json` (önce aynı komutu `--apply` olmadan çalıştırıp önizlemek de mümkündür).

   **DİKKAT — silinecekler listesini mutlaka gözden geçir.** Kuru çalıştırma, sileceği tarihleri kayıt kayıt listeler. Silme kuralı (koddan doğrulandı, `src/ingest/reclassify.ts` + `src/domain/dates.ts`):
   - **Yayım tarihi**, kaydın ilk görülme tarihinden **400 günden fazla eskiyse** ve sayfadaki tarih gerçekten yayım tarihi değilse (yasal atıf vb.) silinir.
   - **Son başvuru tarihi** şu iki durumda silinir: (a) 01.01.2000'den eskiyse, (b) **yayım tarihinden önceyse** (mantıken imkânsız).
   - Hiçbir kayıt **silinmez**; yalnız bu iki tarih alanı `null` olur ve kayıt inceleme kuyruğunda kalır.
   - Kararın değişmez: listeyi okuduktan sonra "bu tarihler gerçekten yanlış" diyorsan `--apply` çalıştır. Tereddüt edersen **çalıştırma**; çıktıyı bana yapıştır, kayıt kayıt birlikte bakarız.
   - Başvuru bağlantısı, kaynak adresi, ilan metni ve diğer tüm alanlar **değişmez**.
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
