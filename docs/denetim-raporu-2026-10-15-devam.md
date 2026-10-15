# Kamuİlan denetim + uygulama raporu — 15 Ekim 2026 (devam turu, PR #15)

Etiketler: **DOĞRULANDI** (kodda + testle/başarıyla kanıtlandı) · **TEST EDİLDİ (MOCK)** (gerçek davranış taklit edilen bağımlılıkla kanıtlandı) · **TEST EDİLMEDİ** (bu turda kanıt üretilmedi) · **ENGELLENDİ** (ortam/izin engeli, aşılmadı) · **VERİ YETERSİZ** (ölçüm aracı hazır, ölçülecek gerçek veri yok).

## 1. Git/PR gerçek durumu — DOĞRULANDI

- Bu oturum `795158b` (main) üzerinden `arena/3779f4f5-kamuradar` koldan başladı. **PR #13 MERGED (08:14:53Z), PR #14 MERGED (09:22:12Z)** — varsayım değil, `gh pr view`/`git log` ile okundu. **PR #3 hâlâ AÇIK** ("Cloudflare vekili, dakikalık tarama varsayılanı…", 12.10'dan beri).
- Bu turda üretilen 6 commit: `15cad0f` fix(db) TLS, `17e6d04` feat(ölçüm) metrikler+telemetri, `e55dbed` chore(deps) package-lock, `b7294d3` test(llm) gerçek soket + hata sızıntısı, `14f2462` feat(eval) etiketleme akışı, `2d3a985` docs(eval).
- **PR #15 → MERGED `10:14:56Z`, merge commit `67cf144`.** `git branch -r --contains 2d3a985` → `origin/main` bu commitleri içeriyor; `origin/main` ucu `67cf144`. CI `verify` bu SHA'da **pass (2m32s)**; adımların tamamı success (`typecheck`, `lint`, `npm test`, `build`, `env:check`, kapsam raporu, **Playwright "Uçtan uca testler"**, rapor artifact). `no-verify` kullanılmadı; `--auto` kullanılmadı.
- Çalışma ağacı temiz; başkasının commiti/dosyası geri alınmadı, silinmedi. Başka bir branşa push yapılmadı.

## 2. LLM'in gerçek ingest/worker hattında çalışması — TEST EDİLDİ (MOCK) / gerçek sağlayıcı: TEST EDİLMEDİ

Üç katman birlikte 10 senaryonun tamamını kapsıyor: `tests/llm-gate.test.ts` (20), `tests/llm-ingest.test.ts` (5), bu turda eklenen `tests/llm-provider-mock-server.test.ts` (11).

| # | Senaryo | Kanıt | Durum |
|---|---|---|---|
| 1 | Deterministik kabul → LLM hiç çağrılmıyor | gate testleri + `llm:review-assist`/ingest testleri: `input.base.decision !== 'review'` → `noop` | TEST EDİLDİ (MOCK) |
| 2 | Review → LLM → `personnel_recruitment` kabul | mock-server testi: gerçek HTTP + `Authorization`/gövde assert'i; `llm-ingest` kabulü | TEST EDİLDİ (MOCK) |
| 3 | Haber/ayrı içerik türü kararı | gate testleri (`ilan-degil` + olumsuz kanıt kalıbı) | TEST EDİLDİ (MOCK) |
| 4 | Süreç duyurusu (`surec`) → process | gate testleri + `personnel_process_announcement` akışı | TEST EDİLDİ (MOCK) |
| 5 | Öğrenci/eğitim/etkinlik/rapor türleri | `NEGATIVE_CUE_PATTERNS` tutarlılık testleri (`tests/llm-gate.test.ts`) + mock-server akışı | TEST EDİLDİ (MOCK) |
| 6 | Zaman aşımı / 429 / 5xx / bozuk JSON / kopan bağlantı | `llm-provider-mock-server.test.ts`: "LLM_TIMEOUT_MS aşıldığında istem iptal edilir ve timeout olarak raporlanır" (istem gerçekten iptal, `timedOut: true`); "429 sonrasında sınırlı yeniden deneme yapar ve kararı uygular"; "kalıcı 5xx: kayıt review kalır, hata telemetriye yazılır, belirsiz kayıt YAYIMLANMAZ"; "geçersiz JSON: doğrulanamayan karar review bırakır ve neden yazılır"; "bağlantı reddi: açık hata mesajı, kayıt incelemede kalır" | TEST EDİLDİ (MOCK) |
| 7 | Uydurma/eksik kanıt | alıntı kaynakta birebir yoksa kabul **reddedilir**, kayıt `review`da kalır | TEST EDİLDİ (MOCK) |
| 8 | Re-scan önbellek isabeti | ikinci kayıtta **HTTP isteği sayacı artmıyor** (sunucu tarafında assert) | TEST EDİLDİ (MOCK) |
| 9 | Bütçe/günlük kota | kota dolunca **hiç istek atılmıyor**; `LLM_MAX_CALLS_PER_RUN` aşımında `blocked` | TEST EDİLDİ (MOCK) |
| 10 | LLM kapalıyken mevcut davranış korunuyor | `LLM_CLASSIFIER_ENABLED=0` → `noop`; `llm:review-assist` ve `eval:classification -- --llm` yapılandırma yoksa **hata verip çıkar**, sahte rapor üretmez | DOĞRULANDI |

Bu turda ek bulgu (gerçek güvenlik/veri sızıntısı düzeltmesi): model çıktısı doğrulanamadığında `llmAnalyses.error`a `JSON.parse` mesajı **aynen** yazılıyordu; bu mesaj ayrıştırılan metnin ön ekini taşıyabilir (ele geçirilmiş anahtar kalıntısı telemetriye sızabilirdi). Artık yalnızca yapı özeti yazılıyor (`describeModelOutputError`, `src/ai/classifier.ts`).

**Gerçek sağlayıcı (OpenAI/uyumlu uç) bu sandbox'tan erişilemediği için çağrı başına gerçek gecikme, gerçek ret oranı ve gerçek maliyet DOĞRULANMADI.** Ölçüm hattının kendisi ise gerçek soketle çalıştırıldı (aşağıda 9. bölüm).

## 3. Gerçek kaynakların doğrulanması — ENGELLENDİ

- `npm run test:live` bu turda **yeniden çalıştırılmadı**; daha önceki koşumlarda kurulu tüm kurumsal kaynaklar ağ katmanında `ECONNRESET` ile kesildi (sandbox çıkış izinleri yalnızca `github.com`, `codeload`, `api.github.com`, `npmjs`, `pypi`). Kurum sayfalarına, `ilan.gov.tr` veya `Resmî Gazete`ye istek atılamadı; robots/ToS ihlali, agresif istek veya TLS doğrulamasını kapatma **yapılmadı ve yapılmayacak**.
- Sonuç: **kaynak başına erişilebilirlik, son nokta, yönlendirme/HTTP davranışı, 304/ETag yeniden taraması, yapı değişimi, alan atıf doğruluğu, sağlık telemetrisi ve çift kayıt kontrolü bu turda DOĞRULANMADI.** Kodda bu davranışların testleri var (uydurma fixture'lara karşı sahte taşıyıcıyla) ve `sourceHealth`/`sourceItemDecisions` tabloları mevcut; ancak hiçbiri "canlı kaynakta doğrulandı" olarak sunulmuyor. `verified` etiketleri tarihsel kanıttır (`docs/limitations.md` kapsam bölümü).
- 304/ETag ve yeniden tarama, sentetik sunucu testleriyle kaplıdır (değişmemiş yanıt → yeniden ayrıştırma yok, `notModified` sayacı), gerçek sunucu üzerinde **TEST EDİLMEDİ**.

## 4. Gerçek veriyle değerlendirme kümesi — VERİ YETERSİZ (üretilen gerçek etiket: 0)

**Bugünkü gerçek durum:** `tests/fixtures/eval/labeled-set.json` = **17 kayıt, `origin:"real"` sayısı 0**, hepsi `spec-title` (spesifikasyon başlığı) kökenli; gövdeler sentetik. Bu kümeyle ölçüm **gerçek saha doğruluğu iddiası üretmez** ve raporda da üretmiyor.

`npm run eval:classification` çıktısı (bu turda gerçekten çalıştırıldı):

- kayıt 17 · gerçek kaynaklı 0 (insan doğrulamalı 0) · sentetik/başlık 17
- `personnel_recruitment` 1/1 P %100 R %100 · `personnel_process_announcement` 1/1 %100/%100 · `student_admission` 3/3 · `education_program` 1/1 · **`news` destek 8 → tahmin 4 → P %100 / R %50 / F1 %66,7** · `event` 1/1 · `report_or_publication` 1/1 · `other` P %20
- karışıklık matrisi: **`news → other` 4 kayıt** (kural boşluğu; etiket kalitesi sorunu değil, gerçek bir eksik)
- yanlış kabul **%0,0** · yanlış ret **%0,0** · belirsiz inceleme **%0,0**
- origin kırılımı: `spec-title` 17 kayıt · insan etiketli 0 · yanlış kabul %0
- **⚠ VERİ YETERSİZ** bloğu ve "İnsan doğrulamalı GERÇEK kayıtlarla metrikler: VERİ YETERSİZ — precision/recall iddiası üretilmiyor" satırı çıktıya dahil
- alan çıkarımı doğruluğu: **ÖLÇÜLEMEDİ** (`expectedFields` yok) · kaynak bazlı hata/belirsizlik: ölçülemedi (`sourceKey` yok)
- LLM kapısı: bu fixture'ta kural 17 kaydı da kesin kararlaştırıyor → **çağrı 0**; `--llm` yapılandırmasız çalıştırılınca "LLM_CLASSIFIER_ENABLED=1 ve LLM_BASE_URL/LLM_API_KEY/… gereklidir" ile çıkıyor (sahte sayı yok)
- 17/17 "doğru" **gibi görünen kısım yalnızca regresyon kanıtıdır**; %100 başarı iddiası edilmiyor (metrik bölümü bunu basınca uyarıyla basıyor)

Bu boşluğu kapatmak için **araç eklendi ve test edildi** (`npm run eval:build-set`, `src/classification/eval-set.ts`):

- depodaki kayıtlardan **salt okunur** etiketleme sayfası üretir; `expectedContentType` **boş**, kural/model tahmini `machineSuggestion`da (altın etiket değil); kırpık gövde `notes`ta ihtar edilir
- `origin:"real"` için iki koşul: `provenance:"scraped"` **ve** anahtar `SOURCE_DEFINITIONS`ta (`seed:demo`/`manual-entry` gerçek sayılmaz)
- `--import` ret kuralları: etiket boş · gerçek kayıt ama provenans `human` değil · `labeledBy/labeledAt` eksik — üçü de test edildi
- `--apply` olmadan **hiçbir yere yazmaz**; kabul 0 ise exit kodu 1 (test, bu bilinçli exit kodunu okuyacak şekilde yazıldı)
- kapsam hedefleri: **145** (personel alımı 40 · süreç 25 · haber 25 · öğrenci 15 · eğitim 10 · etkinlik 10 · rapor 10 · diğer 10) + hedef dışı zorunlu örnekler (süresi geçmiş gerçek alım, çok şehirlı ilan, tarih türlerinin bir arada olduğu metin, eksik liste kartı metni, komşu kart sızıntısı) — `docs/eval-gercek-veri.md`

**Gerçek insan doğrulamalı kayıt sayısı bu turda 0'dır ve "150–200 küme hazır" denmiyor.**

## 5. Alan çıkarımı denetimi — DOĞRULANDI (kod) / doğruluk: VERİ YETERSİZ

- `ExtractedJob` (`src/extraction/engine.ts:94-116`) 21 alan taşıyor; denetimin istediği 11'i şöyle karşılık buluyor: kurum `institution`, birim `unit`, unvan `titles[]`, sayı `quota`, il `city` (+`district`), öğrenim `educationLevels[]`, KPSS taban `kpssMinScore` (+`kpssScoreTypes`/`kpssYear`), başvuru başlangıcı `applicationStartAt`, son başvuru `applicationEndAt` (+gün-son hâli `applicationEndDate`), yayım `publishedAt`, resmî bağlantı `applicationUrl` (+`applicationMethod`, `referenceNo`, `cadreStatus`, `departments`, `qualificationCodes`). Alanlar **yalnızca kaynak metinde açık ifade varsa** `setField(...)` ile kanıt alıntısıyla doldurulur; kanıtı bulunamayan alan `null` kalır ve kayıt belirsiz sayılır — bu davranış testlerle kilitli.
- **Tarih rolleri ayrımı (4 tür) test edildi:** `tests/date-roles.test.ts` — (a) "Yazılı sınav 15.11.2026" geçse bile `end` 30.10.2026 kalır (sınav tarihi son başvuru olmaz), (b) başvuru cümlesi olmayan tek tarih **hiç atanmaz** (`start`/`end` null), (c) "son başvuru tarihi 20.10.2026" doğru rolle alınır. Kodda ayrı bir `examAt`/sınav-tarihi alanı **yoktur**: sınav/kura/sonuç tarihi yapısal alana dönüştürülmez, metinde bırakılır — bu bilinçli bir seçimdir ve bu turda **değiştirilmedi**; sınav tarihini yapısal alan isteyen bir iyileştirme 13. maddede ayrı kalem olarak duruyor.
- **Kanıt kapısı korundu:** alan çıkarımına LLM **sokulmadı**; model yalnızca sınıf kararı verebilir ve kanıtı kaynak metinde birebir doğrulanmadıkça hiçbir karar uygulanmaz.
- Liste kartından gelen kısa metinde (`bodyTextSource: 'listing'`, `capturedTextStatus !== 'captured'`) alan **uydurulmaz**; eval/etiketleme tarafında da kırpık gövde "tam metin" sayılmaz (bu turda `eval-set` içe aktarıcısına aynı kural kondu: alıntı < 200 karakter veya durum `captured` değilse `body` yazılmaz).
- **Alan çıkarımına LLM sokulmadı**; tek LLM teması, kanıtı kaynakta birebir doğrulanan sınıf kararıdır.
- Saha doğruluğu (kurum/unvan/il/sayı tarih yüzdelikleri) **VERİ YETERSİZ**: `expectedFields` etiketi olmadan ölçülemez; ölçüm kodu hazır ve `ÖLÇÜLEMEDİ` yazıyor.

## 6. Kullanıcı arayüzü baştan sona — KISMEN DOĞRULANDI

- CI'daki **Playwright uçtan uca 12 test bu merge'de success**: ana sayfa + dürüst kapsam notu, aramanın sorgu parametreleriyle listeye taşınması, filtrelerin URL'den paylaşılabilirliği, kaynaklar sayfasında doğrulama/tarama ayrımı, oturumsuz kullanıcının giriş kapısına düşmesi (kayıt linki yok), admin bölümünün RBAC kapısı, bilgi sayfaları, 404, sağlık ucu. Yerelde tarayıcı indirilemedi (`npx playwright install chromium` CDN'e ulaşamıyor) → **lokal e2e ENGELLENDİ**, kanıt CI koşumu.
- Terminallere/kuyruğa dokunan arayüz davranışları birim+entegrasyon testleriyle kaplı (inceleme kuyruğu, kaynak sağlığı kartı, boş/yükleniyor/hata durumları, kayıtlı ilan/bildirim akışları). Bu turda `tests/design-system.test.ts` ihlali bulundu ve giderildi (`src/pages/Admin.tsx` içindeki sınıftız `muted` → `cell-note`) → 7/7.
- **Görsel/erişilebilirlik taraması (mobil kırılımlar, klavye, kontrast) ve gerçek tarayıcıda elle gezinme TEST EDİLMEDİ**; yeni buton/etiket eklenmedi, ölü bağlantı/stub veri eklenmedi (Admin panelindeki eval ve LLM kartları yalnızca gerçek script çıktısını ve "veri yok" durumunu gösteriyor).

## 7. Bildirimler / outbox / e-posta / Telegram — TEST EDİLDİ (MOCK)

- Yalnızca **yeni ve gerçek kabul edilmiş** ilan bildirir: süreç duyurusu, haber ve belirsiz kayıt bildirim üretmez; re-scan'da çift bildirim çıkmaz (dedupe + outbox kilidi) — testlerle kilitli.
- Sağlayıcı hatasında kayıt kaybolmaz/yinelenmez: outbox satırı `pending` kalır, yeniden deneme sınırlı; e-posta/Telegram "kabul edildi" ile "teslim edildi" ayrı tutulur.
- Geliştirmede varsayılan **kapalı** (`RESEND_API_KEY`/`TELEGRAM_BOT_TOKEN` yokken gönderim yok, kuyruk birikir) ve `dev:smtp` yerel yakalayıcı kullanılır.
- **Gerçek teslimat kanıtı YOK** (gerçek e-posta/Telegram hesabına bu ortamda erişilemedi) → gerçek teslimat: TEST EDİLMEDİ. Panelde günlük özet modu hâlâ sunulmuyor (mevcut tercih "kullanılamıyor" olarak işaretli, `docs/limitations.md`).

## 8. Production güvenliği — DOĞRULANDI (TLS) / karışık

- **Düzeltilen gerçek hata:** `POSTGRES_URL` kurulu + CA yokken `ssl = { rejectUnauthorized: false }` üretiliyordu (Supabase bağlantısı şifreli ama kimlik doğrulanmıyor → MITM'e açık). Yeni davranış: **varsayılan doğrulama AÇIK** (sistem güven deposu + Node kökleri), `POSTGRES_SSL_MODE` ile `verify-full|verify-ca|no-verify|disable`; `no-verify|disable` production'da `getEnv()`ni **patlatır** (geliştirmede uyarı + `env:check` satırı); CA dosyası tanımlı ama okunamıyor/boşsa sistem CA'sına sessiz düşmez, hata verir; connection string'de `sslmode=`/`options=`/`;` reddedilir; havuza `ssl` nesnesi açıkça verilir. Kanıt: `tests/postgres-tls-config.test.ts` **16/16** — gerçek el sıkışma dahil (self-signed **reddedilir**, sistem güven deposuyla kabul, `disable`da SSLRequest gitmez).
- **Açık kalan belge çelişkisi:** `docs/.env.example` "bağlantı dizesinde `sslmode` yazıyorsa o kazanır" diyor; kod `ssl` nesnesiyle URL'dekini eziyor. 16. maddeye yazıldı (belge düzeltmesi gerekir).
- Anahtarlar: `inspectEnv` masked değerler döndürür, loglarda anahtar/TCKN maskeleme (`redact`) ve KVKK/iletişim maskelemesi mevcut ve migration sonrası eski kayıtlarda bile e-posta/telefon/TCKN'nin `textExcerpt`/`evidence`/`fieldSources`a girmediği test ediliyor (`tests/captured-text-migration.test.ts:116-191`); model çıktısı doğrulanamayan kayıtta ham içerik **kaydedilmiyor** (bu turda sıkılaştırıldı). Admin yetkisi oturum + RBAC ile kapılı ve e2e ile test edildi; Supabase tarafında RLS politikaları kodda tanımlı ancak **gerçek Supabase üzerinde sorgu bazında DOĞRULANMADI**. SSRF koruması `src/sources/fetcher.ts:127+` bloklistesiyle (link-local/bulut metadata `169.254.*`, ondalık `2130706433`, `0x7f000001`, `::ffff:127.0.0.1`, `localhost`, `file:`) ve **tam eşleşen** alan adı beyaz listesiyle (kök alan alt alan adını kapsamaz) çalışıyor; yönlendirmeler `maxRedirects` sınırında her atlamada yeniden doğrulanıyor (`tests/audit-fixes.test.ts` "kaynak adresi güvenliği (SSRF)"); prompt-injection savunması (güvenilmez blok, kanıt enjeksiyon kalıpları, `evidenceLooksLikeInjection`) gate testlerinde doğrulandı. Oran sınırları (rate limits) ve `AI_DAILY_LIMIT_PER_USER` mevcut; yük testi yapılmadı.

## 9. Maliyet ve hata yönetimi — DOĞRULANDI (mekanizma) / fiyatlar: DOĞRULANMADI

- Kapı varsayılan **kapalı**; eştakararlılık, günlük kota, koşu bütçesi, paralellik sınırı, sınırlı zaman aşımı + sınırlı deneme (sonsuz retry yok; `Retry-After` okunur, `backoff * attempt` ile sınırlı).
- Önbellek anahtarı **model + istem sürümü + içerik özeti** içerir (`kamuilan-sinif-v1`); metin < 200 karakterse çağrı **yapılmaz** (kısa liste kartıyla karar üretilmez). Bu turda bu iki korumanın gerçek akışta çalıştığı mock sağlayıcıyla görüldü.
- Ölçülen maliyet tek gerçek fiyat kaynağından geliyorsa raporlanır: `LLM_COST_USD_PER_MTOK_INPUT/OUTPUT` boşken **"maliyet raporlanmadı: sağlayıcı fiyatı doğrulanmadı"** yazılır, rakam uydurulmaz; girildiğinde satır `TAHMİN — …sağlayıcı fiyat listesi canlı doğrulanmadı` önekiyle basılır.
- **Telemetri hattının kendisi ölçüldü**: `--llm` koşumu yerel OpenAI-uyumlu sahte sağlayıcıya karşı gerçek soketle çalıştırıldı → `belirsiz kayıt 1 · API çağrısı 1 (%100) · gecikme p50 58 ms · token 900 girdi + 120 çıktı · hata oranı %100 · maliyet ~$0.0006 (TAHMİN)`, karar `doğrulanamadı 1` → **kayıt incelemede kaldı, otomatik yayınlanmadı**. Sayılar **sahte sağlayıcıya aittir**; gerçek operatör gecikmesi/maliyeti hakkında hiçbir şey söylemez. (Bu deneme `data/` içindeki geçici sürücüyle yapıldı, depoya girmedi.)

## 10. Production verisine dokunma — DOĞRULANDI (salt okunur) / production'a hiç dokunulmadı

- Bu sandbox'ta Supabase kimliği yok; **production veritabanına hiç bağlanılmadı**. Yerel dosya deposu (`DATABASE_DRIVER=file`) üzerinde `seed:demo` ile 3 demo kayıt kuruldu ve gerçek betıklar çalıştırıldı:
  - `npm run jobs:reclassify` → `MOD: KURU ÇALIŞTIRMA (yazılmayacak)`; toplam kayıt 3, akışta önce 3 / sonra 3, `job` 3, `process` 0, akıştan çıkacak 0, akışa girecek 0, türü değişecek 0, başlık temizlenecek 0, durum değişecek 0, **toplam değişecek kayıt 0**, bekleyen bildirim 0, bastırılacak 0; "Uygulamak için: `--apply`" satırı.
  - `npm run llm:review-assist` → kapı yapılandırılmadığı için **"LLM kapısı yapılandırılmamış"** ile çıktı; rapor/veri uydurulmadı.
- **Toplu yazma/silme/yeniden sınıflandırma yapılmadı; `--apply` hiç kullanılmadı** (onay yok). Yedek/geri alma yolu yerinde: `jobs:restore` + reclassify'ın yedek mekanizması (bu turda uygulanmadı, test edildi).
- Deneme sonrası `data/` temizlendi (geçici dosyalar silindi, depoya girmedi).

## 11. Çalıştırılan komutlar ve gerçek sonuçlar — DOĞRULANDI

| Komut | Sonuç |
|---|---|
| `npm test` | **71 dosya / 783 test YEŞİL** (tur başlangıcı 68/735 → +3 dosya, +48 test) |
| `npx tsc --noEmit`, `npm run typecheck` | 0 hata |
| `npm run lint` | 0 hata/uyarı |
| `npm run build` | başarılı (vite 301 ms) |
| `npm run env:check` | 0; TLS satırı raporlanıyor |
| `npm run eval:classification` | 17 kayıt, 0 gerçek; `news` R %50; `news → other` 4; yanlış kabul/ret/belirsiz %0; **VERİ YETERSİZ** |
| `npm run eval:classification -- --llm` (yapılandırmasız) | beklenen hata mesajı + exit 1 (sahte çıktı yok) |
| `npm run eval:classification -- --llm` (yalnızca mock) | telemetri bloğu: 1 çağrı, 58 ms, 900/120 token, `~$0.0006` TAHMİN, `doğrulanamadı 1`, kayıt review'da kaldı |
| `npx vitest run tests/eval-build-set.test.ts` | 9/9 (CLI uçtan uca dahil) |
| `npx vitest run tests/llm-provider-mock-server.test.ts` | 11/11 |
| `npx vitest run tests/postgres-tls-config.test.ts` | 16/16 |
| `npx vitest run tests/design-system.test.ts` | 7/7 (Admin.tsx sınıf düzeltmesiyle) |
| `npm run test:live` | bu turda yeniden çalıştırılmadı; önceki koşumlarda tüm kaynaklar `ECONNRESET` → **ENGELLENDİ** |
| `npm run test:e2e` (yerel) | **ENGELLENDİ**: Chromium indirilemiyor (ağ izni) → 12 test "browserType.launch: Executable doesn't exist" |
| CI `verify` (PR #15, `2d3a985`) | **pass 2m32s**, Playwright adımı dahil success |
| `npm run jobs:reclassify`, `npm run llm:review-assist` | yukarıda 10. madde |

## 12. Commit / PR / CI / merge — DOĞRULANDI

- 6 küçük, tek amaçlı commit (yukarıda listeli), hiçbiri başka birinin işini ezmedi.
- **PR #15** (`#13`, `#14` sonrası): açıklama "ne değişti / testler / riskler / bilinçli olarak doğrulanmayanlar" bölümleriyle yazıldı.
- CI `verify` **yeşil** → `gh pr merge 15 --merge` → `MERGED`, merge commit `67cf144`; `git fetch` sonrası `origin/main` içeriği doğrulandı (`git branch -r --contains 2d3a985`).
- PR #3 hâlâ **AÇIK**; içeriği (Cloudflare vekili, dakikalık tarama varsayımı, eksik yüzeyler) bu turda uygulanmadı — kapsam dışı bırakıldı, kapatılmadı.

## 13. Kalan riskler ve sonraki adım (yol haritası)

1. **GERÇEK ETİKETLİ KÜME (en yüksek öncelik, engel: ağ).** Ağ erişimi olan bir operatör makinesinde: `npm run start:worker` ile canlı tarama → `npm run eval:build-set -- --filter review --limit 60` → resmî bağlantılardan elle etiketleme (`expectedFields` dahil) → `--import` (kuru) → `--apply` → `npm run eval:classification` ve `-- --llm`. Hedef: 145+ gerçek/insan doğrulamalı kayıt; `news` sınıfını hedefin üstünde örnekle (bugünkü tek ölçülebilir kural boşluğu `news → other`). **Bu yapılana kadar "doğruluk" diye bir sayı yayımlanmamalı.**
2. **Canlı kaynak doğrulaması (ENGELLENDİ maddesinin kapanması):** her kaynak için tek seferlik koşum → erişilebilirlik/yönlendirme/304/yapı-değişimi/atıf/çift-kayıt kontrolü; erişilemeyen kaynak için `test:live` çıktısının arşivlenmesi. TLS doğrulaması asla kapatılmamalı.
3. **Gerçek LLM sağlayıcı koşumu:** düşük bütçe (`LLM_MAX_CALLS_PER_RUN` küçük) + `eval:classification -- --llm` + `llm:review-assist` raporu; gecikme/token/maliyet satırlarının gerçek değerleriyle kaydı; fiyatlandırmanın sağlayıcı sayfasından doğrulanıp `LLM_COST_USD_PER_MTOK_*` alanına girilmesi (bugün fiyatlar **doğrulanmamış** durumdadır).
4. **Belge çelişkisini gider:** `docs/.env.example`deki "bağlantı dizesindeki `sslmode` kazanır" cümlesi kodla uyuşmuyor — ya cümle kaldırılsın ya da URL değeri okunup ona göre davranılsın (tercih: dokümanı koda uydurmak).
5. **Supabase üzerinde RLS/istek bazlı doğrulama:** gerçek projede `anon`/`service_role` ile okuma denemeleri + `db:migrate`/`db:indexes` durumunun raporlanması (kodda var, canlıda kanıt yok).
6. **Gerçek teslimat kanıtı:** tek alıcıya `RESEND`/Telegram ile gönderim, kuyruk `sent`/`failed` sayılarının ve tekrar-etmeme davranışının operatör tarafında doğrulanması.
7. **Erişilebilirlik/mobil taraması:** klavye yürüyüşü, kontrast, 320/390 px kırılımları — Playwright `chromium` ile ekran görüntülü kontrol (CI'da tarayıcı kurulabiliyor).
8. **`Admin` panelinde veri-azaltma uyarısı:** etiketleme sayfasının `data/` altında üretilmesi ve `--apply` gereği zaten panelde yazılı; re-scan sonrası `eval:build-set` çıktısının periyodik (ör. haftalık) koşulması bir zamanlı görev olarak tanımlanabilir — yeni altyapı gerektirmez, mevcut scheduler'a iş eklenir.
9. **Yapısal sınav/kura/sonuç tarihi alanı yok** — bu bir tasarım kararı olarak kaldı (yanlış rol atamasının maliyeti, alanın yokluğundan büyük), ama sürece bağlı ilanlarda "sınav ne zaman" sorusu panelde yanıtlanamıyor. Küçük adım: `ExtractedJob`a `processEventAt` + `processEventType (sinav|kura|sonuc|itiraz)` eklemek, **yalnızca** cümle rolü net kalırsa doldurmak, `expectedFields` etiketiyle alan doğruluğunu ölçmek; `ExtractedJob` şeması `jobSchema`/`fieldSources` üzerinden gittiği için ek bir tablo gerekmez.
