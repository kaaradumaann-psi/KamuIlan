# Kamuİlan — Baseline ve risk envanteri

**Baseline zamanı:** 2026-10-17 UTC
**Baseline commit'i:** `57b2e7c73839d888ac38da7df873d25b5f83270c`
**Çalışma dalı:** `arena/2829bca7-kamuradar`
**Bu belge:** değişiklik öncesi gözlem; sonraki uygulama/test sonucu aşağıdaki “Tur sonu” bölümüne eklenecek. Önceki denetim belgeleri tarihsel kanıttır, bu baseline'ın yerine geçmez.

## 1. Git ve çalışma ortamı

- `git status --short --branch`: temiz, `## arena/2829bca7-kamuradar`.
- `git branch --show-current`: `arena/2829bca7-kamuradar`.
- `git log -8 --oneline --decorate`: yalnızca `57b2e7c` görünür; checkout **shallow** (`git rev-parse --is-shallow-repository` → `true`).
- Yerel `main`, `origin/main` ve oturum dalı aynı `57b2e7c` commit'inde; `git rev-list --left-right --count origin/main...HEAD` → `0 0`. GitHub `git ls-remote origin refs/heads/main` da `57b2e7c73839d888ac38da7df873d25b5f83270c` döndürdü.
- `git remote -v`: credential içermeyen HTTPS origin.
- `gh pr list --state all --limit 15`: PR #21 (önceki denetim) ve daha eski PR'lar MERGED; `gh issue list --state open`: açık issue yok.
- Başlangıçta `.env`, `.env.local`, `.env.test` ve repo `data/` dizini yoktu. Dosya içerikleri/sırlar tarama amacıyla açılmadı. `NODE_TLS_REJECT_UNAUTHORIZED` ve sağlayıcı/DB/posta/bot anahtarı değişkenleri yalnızca var/yok olarak kontrol edildi; bu baseline sırasında ayarlı değillerdi.
- Node `v22.22.3`, npm `10.9.8`.

## 2. Gerçek baseline komutları

Komutlar değişiklik öncesi çalıştırıldı. Test/build adımlarında sağlayıcı ve DB credential ortam değişkenleri alt süreçten kaldırıldı; kaynak fetch ve tarayıcı yedeği kapatıldı. Komutların logları `/tmp/kamuradar-baseline-*.log` altındadır (repo'ya alınmaz).

| Komut | Exit | Kanıt / kapsam |
|---|---:|---|
| `npm ci` | 0 | Lockfile'dan 387 paket kuruldu; npm 388 paketi denetledi, 0 advisory bildirdi. Uyarılar: deprecated `whatwg-encoding` ve destek dışı ESLint 9 sürümü. |
| `npm run env:check` | 0 | Sır basmayan özet; `.env` yok. Varsayılan geliştirme ortamında `SOURCE_LIVE_FETCH=true`, Chromium yedeği açık, scheduler açık ve `APP_SECRET` yok/kısa uyarısı gösterdi. Bu komutun güvenli görünmesi, `test:live` çağrısının güvenli olduğu anlamına gelmez. |
| `npm run typecheck` | 0 | `tsc --noEmit`. |
| `npm run lint` | 0 | ESLint. |
| `npm test` | 0 | Vitest: **102 dosya, 1.276 geçti**, başarısız/skipped/todo raporlanmadı; 120,82 sn. Unit ve offline integration aynı Vitest katmanında karışık. HTTP/LLM sayacı baseline'da yoktu; yalnızca `SOURCE_LIVE_FETCH=0` ve tarayıcı fallback kapalıydı. Dolayısıyla “dış çağrı sayısı ölçüldü ve sıfır” iddiası baseline için yapılamaz. |
| `npm run test:coverage` | 0 | Vitest: **102 dosya, 1.276 geçti**. Statements **%77,39**, branches **%67,68**, functions **%73,03**, lines **%79,93**. Kritik dizinler: `src/ai` %91,91 / %80,62 / %94,73 / %94,42; `src/classification` %96,55 / %92,61 / %94,44 / %95,89; `src/extraction` %92,76 / %80,61 / %96,20 / %95,40; `src/ingest` %92,16 / %85,79 / %86,11 / %94,01; `src/sources` %70,56 / %65,20 / %64,28 / %72,95; `src/db` %65,92 / %58,12 / %66,66 / %68,99; `src/server/routes` %69,13 / %48,87 / %76,33 / %70,76; `src/worker` %61,68 / %58,90 / %55,88 / %63,69. Sıra her satırda statements/branches/functions/lines. `src/worker/trigger.ts` %0 kapsamda. |
| `npm run build` | 0 | `tsc --noEmit` + Vite production bundle; 113 modül. PDF.js testlerinde standard-font/indexing uyarıları görüldü, testler geçti. |
| `npm run eval:classification` | 0 | Deterministik, çevrimdışı. 17 kayıt; 0 gerçek kaynaklı, 0 insan etiketli; 17 `spec-title`. Başlık/sentetik regresyonunda görünen %100 oranlar gerçek doğruluk değildir; script doğru olarak `VERİ YETERSİZ` dedi. `expectedFields` olmadığı için alan doğruluğu ölçülmedi. |
| `npm run llm:doctor -- --offline` | 1 | Kod yolu offline seçildi; ortamda provider adresi/model/anahtar yok. Tanı yapılandırılmamış olduğu için exit 1. Bu, provider smoke testi değildir; hiçbir provider çağrısı yapılmadı. |
| `npm run sources:report -- --json` (geçici `/tmp` `DATA_DIR`, `DATABASE_DRIVER=file`) | 0 | İzole, boş test deposu; yalnız statik envanter ve geçmiş status/evidence. Üretim DB'ye bağlanılmadı. |
| `npm audit --json` | 0 | Ağdan npm advisory verisi alarak lockfile kapsamı tarandı; info/low/moderate/high/critical tümü 0. Bu bir SAST/secret scan değildir. |
| Playwright browser durum kontrolü | — | `npx playwright install --list`: `/home/user/.cache/ms-playwright/.links` bulunamadı. Yerel Playwright E2E bu baseline'da başlatılmadı ve **BLOCKED**; sonucu PASS sayılmadı. |
| `npm run test:live`, gerçek `fixtures:capture`, `llm:doctor` live, `eval:classification -- --llm`, e-posta/Telegram | NOT RUN | Resmî kurum hostlarına bu sandbox'tan ağ erişimi yok; provider anahtarı yok; gerçek kullanıcıya bildirim riski var. Dış ağ/LLM/posta/bot çağrısı: bu komutlar için **0**. |

`npm run test:coverage` satırındaki yüzdeler toplam kod kapsamıdır; fixture'ların gerçek kaynaktan geldiğini veya üretimde doğruluğu kanıtlamaz.

## 3. Test katmanları ve mevcut kanıtın sınırı

| Katman | Baseline durumu | Kanıtın sınırı |
|---|---|---|
| Unit | Vitest içinde mevcut; PASS | Saf fonksiyonlar, normalizasyon, sınıflandırma ve alan çıkarımı testleri var. Suite statik olarak unit/integration diye ayrılmıyor. |
| Integration (offline) | Vitest içinde mevcut; PASS | FileStore, PGlite/Postgres uyumluluğu, Fastify `inject`, fake fetch/provider ve süreç içi SMTP testleri var; canlı Postgres/Supabase/RLS kanıtı değil. |
| Fixture/contract | Mock/synthetic contract testleri var; gerçek snapshot kapsamı yok | `tests/sources.test.ts` içinde elle yazılmış HTML/JSON; `tests/fixtures/announcements.ts`; üretilmiş küçük PDF örnekleri. `fixtures/html` içinde kaynak snapshot dosyası/manifesti yok. Bunlar güncel canlı DOM sağlığını göstermez. |
| E2E local | **BLOCKED** | `e2e/*.spec.ts` Playwright testleri mevcut; bu worktree'de Chromium kurulu değil. İzole API/DB ile bu turda çalışmadı. |
| Opt-in live | **NOT RUN** | Kaynak/LLM/e-posta/Telegram için sıfır canlı kontrol. HTTP 200 bile extraction accuracy kanıtı olmaz. |

## 4. Kaynak envanteri (statik kod kanıtı)

- `src/config/sources.ts`: **28** source definition; **24 etkin**. Durum etiketi dağılımı: `verified` 15, `scraper-built` 9, `needs-manual-method` 4. `PLANNED_SOURCES`: 4 kapsam grubu.
- `src/sources/registry.ts`: **10** adapter key; bütün 28 `adapterKey` eşleşmesi mevcut. Bu, kod eşlemesini doğrular; kaynağın güncel çalıştığını değil.
- `verified`/`lastVerifiedAt`/`verificationEvidence` depo içindeki geçmiş veya elle taşınmış kanıttır. Bu turda **0 kaynak canlı doğrulandı**; 15 etiketi “bugün sağlıklı” diye yorumlanamaz. Boş geçici depoda son HTTP durumu, son başarı, ilan üretim zamanı ve parse oranı bilinmiyor.
- Gerçek, izinli/versiyonlu HTML/PDF snapshot'ı görünmüyor. Adapter testleri çoğunlukla mock/stub. Kaynak bazlı fixture coverage için `INSUFFICIENT DATA`.
- `src/sources/network-safety.ts` ve `src/sources/fetcher.ts` incelendi: literal özel IP engeli yanında tüm DNS cevaplarını doğrulayıp yalnız doğrulanan public adresleri kullanan lookup, elle redirect doğrulaması, TLS doğrulaması, içerik/redirect sınırları var; `tests/fetcher.test.ts` karışık public/private DNS cevabını reddediyor. Bu kod test kapsamı canlı ağ/kurum yetkisi kanıtı değildir.
- `docs/limitations.md` runtime `robots.txt`/kullanım şartı kapısının uygulanmadığını, taranmış PDF için OCR olmadığını (metin katmanı yoksa inceleme), gerçek veri etiketli küme bulunmadığını açıkça söylüyor.

## 5. Gerçek etiketli veri ve ölçüm

- `tests/fixtures/eval/labeled-set.json`: 17 adet `origin=spec-title`; kaynak URL'si/sourceKey'i, `labeledBy`/`labeledAt`, insan gerekçesi ve `expectedFields` yok.
- `ai-kapisi-senaryolari.json`: 4 sentetik senaryo; `ai-kapisi-tek-senaryo.json`: 1 sentetik senaryo. Provider/replay testlerine yarar; gerçek duyuru, insan altın etiketi veya gerçek sağlayıcı benchmark'ı sayılmaz. Dosyalar arası ID örtüşmesi ayrıca değerlendirme raporunda sayılmalıdır.
- **Gerçek + insan doğrulamalı kayıt: 0 / hedef 150; eksik 150.** İnsan etiketleme sayfası ve doğrulama akışı kodda mevcut (`eval:build-set`); gerçek resmî kaynak gövdesi/URL ve insan etiketi olmadan sentetik veriyle hedef doldurulmadı.
- Sınıflandırma confusion matrix'i test dataseti regresyonudur; üretim precision/recall `INSUFFICIENT DATA`. Kritik alan exact/normalized-match, kanıt doğrulama oranı, false positive/negative ve duplicate recall ölçülemedi.

## 6. AI çağrı akışı, maliyet ve gizlilik (kod okuması)

- **Ingest sınıflandırma:** `src/ingest/jobs-service.ts` deterministik sonucu `review` ise `src/ai/classifier.ts` kapısına gider. `LLM_CLASSIFIER_ENABLED` varsayılan kapalı; kanıt/şema doğrulaması geçmezse review kalır. İçerik/model/prompt cache'i `llmAnalyses`; koşu başı `LLM_MAX_CALLS_PER_RUN` (varsayılan 12), günlük `LLM_DAILY_CALL_LIMIT` (varsayılan 400), retry sınırı ve worker-ici concurrency var.
- **Panel önerileri:** `src/server/routes/ai.ts` → `src/ai/suggest.ts`; açık AI bayrağı ve kullanıcı rızası/profil gerekir, aday kümesi sınırlı, kullanıcı başına günlük limit (varsayılan 5), 20 dk **process-memory** cache. Kullanıcı profili bu akışta provider'a gider; canlı veri kullanımı/retention politikası bu sandbox'ta doğrulanmadı. Global classifier ve assistant harcama bütçesi tek kapıda değil.
- **Taşıyıcı:** `src/ai/llm.ts` OpenAI uyumlu ve Gemini-native HTTP; timeout, response size, retry/Retry-After, hata redaksiyonu ve token telemetry mevcut. Model/prompt/schema kanıtını gövde loglamadan tutma yaklaşımı var.
- **Maliyet:** token ve operatör fiyatı varsa sonradan tahmini maliyet hesaplanıyor; fiyatlar boşsa `null`. Başlangıç kodunda koşu/gün USD hard-cap'i yok; fiyat varsayımı kaydı provider faturasını garanti etmez. Hard budget aktifken fiyat yoksa çağrıyı durduran ortak politika mevcut değil.
- **Tanı/benchmark komutları:** `scripts/llm-doctor.ts` CLI varsayılanı live; doktorun kod bütçesi 5 HTTP çağrısı ve 1 retry, maliyet tavanı yok. `scripts/eval-classification.ts --llm` provider'a gidebilir; komut satırında zorunlu live onayı/USD token/call flag'i yok. `scripts/live-check.ts` `.env` varsayılanında `SOURCE_LIVE_FETCH=true` iken `--source` verilmezse etkin kaynakların tümünü deneyebilir; sayfa/istek/cost flag'leri yok. Bu komutlar baseline sırasında çalıştırılmadı.

## 7. Güvenlik bulguları (baseline)

| ID / severity | Kanıt ve kök neden | Etki / mevcut kontrol | Durum |
|---|---|---|---|
| S1 — **HIGH (maliyet/ağ izolasyonu)** | `tests/setup.ts:2-6` yorumda “fetch engellenir” diyor ancak `:8-28` yalnız env bayraklarını atıyor. `src/ai/llm.ts:850-856` varsayılan gerçek `global fetch`; test ortamını reddetmiyor. | Bugün testlerin çoğu fake fetch/MockAgent kullansa da yanlışlıkla eklenen çağrı gerçek provider'a çıkabilir; dış HTTP 0 değeri ölçülmüyor. | Düzeltme/test gerekli. |
| S2 — **HIGH (kontrolsüz opt-in yüzeyi)** | `scripts/live-check.ts:104-120`: `.env` `SOURCE_LIVE_FETCH=1` iken live çalışır ve kaynak seçilmezse enabled kaynakların tamamına gider; 24 kayda kadar, sabit 5 detail, global request/page limiti yok. `scripts/llm-doctor.ts` canlı varsayılan (5 request, retry), `eval:classification --llm` için explicit limitler yok. | Operatörün tek komutla beklenmedik ağ/ücret tetiklemesi; yavaş/boş kaynaklar yanlış yorumlanabilir. | Komut bayrakları fail-closed olmalı. |
| S3 — **HIGH (LLM hard cost ceiling yok)** | `src/config/env.ts:340-347`, `src/ai/classifier.ts` telemetry maliyeti; fiyat boş olabilir ve hesaplama sonrası. Call/day limitleri USD tavanı değil. | Sağlayıcı fiyatı veya input tokeni büyüdüğünde çağrı adedi sınır içinde kalsa da maliyet tavanı garanti değil. | Provider fiyatı/operator limit olmadan canlı çağrı yok; merkezi politika gerekli. |
| S4 — **HIGH (kalibrasyon verisi yok)** | Etiket dosyası 17 `spec-title`, 0 real/human, 0 expected fields. | Üretim false-negative/false-positive, alan doğruluğu ve kanıt oranı ölçülemez; synthetic %100 yanıltıcı olabilir. | Veri erişimi ve insan etiketi bekliyor; `INSUFFICIENT DATA`. |
| S5 — **HIGH (güncel kaynak sağlığı kanıtı yok)** | 28 statik kaynak, 15 geçmiş `verified`; taze live koşu bu turda 0. | Kaynak kapsamı, 0-result nedeni, güncel selector/HTTP sağlığı ve ilan eksikliği bilinmiyor. Kaynak erişimi engellenmiş. | Operatörün yetkili ağında sınırlı live doğrulama `BLOCKED`. |
| S6 — **MEDIUM (fixture kontratı gerçek snapshot değil)** | `fixtures/html` snapshot/manifest yok; `tests/sources.test.ts` inline mock/hand-authored HTML ve synthetic PDF. | Gerçek DOM değişimi contract testinde yakalanmıyor. | PII/şartlar kontrolü ve izinli gerçek snapshot gerekir; mevcut testler yalnız mock. |
| S7 — **MEDIUM (daily rate-limit yarış/fail-open)** | `src/db/repos/system.ts` `RateLimitRepo.hit` read-then-write; concurrent updates kayıp sayılabilir. `src/ai/classifier.ts` daily counter yazım hatasını `.catch(() => undefined)` ile yutar ve yine provider çağırır. | Eşzamanlı worker'lar quota'yı aşabilir; storage arızasında fail-open. | Atomik increment + fail-closed regression testi gerekli. |
| S8 — **MEDIUM (E2E kanıtı eksik)** | Playwright `e2e/*.spec.ts` var, Chromium browser bulunamadı. | UI/API gerçek akışı bu runner'da doğrulanmadı. | Yerel/CI browser kurulumu bekliyor; bu turda `BLOCKED`. |
| S9 — **MEDIUM (OCR/alan doğruluğu)** | `docs/limitations.md`: OCR yok; `expectedFields` bulunmuyor. | Scanned PDF içeriği sessizce doğru çıkarılamıyor; field exact/coverage/kanıt metrikleri yok. | OCR ürün/altyapı seçimi ve gerçek etiketli PDF gerekir. |
| S10 — **MEDIUM (kapsam/uyum kapısı)** | `docs/limitations.md` runtime `robots.txt`/ToS compliance otomatik zorlanmadığını belirtiyor. | Onboarding belgesi/operatör incelemesi dışında kodda erişim uygunluğu kapısı kanıtlanmadı. | Canlı tarama öncesi kaynak şartları ayrıca operatörce incelenmeli; CAPTCHA/WAF aşılmamalı. |

**Pozitif güvenlik kanıtı (sınırlı):** `npm audit --json` exit 0, 388 paket için advisory yok; URL/SSRF/DNS, CSRF/RBAC, auth, TLS, XSS ve API güvenlik regression testlerinin bir kısmı Vitest'te var. Tam OWASP/ASVS, secret scanning, SAST, RLS, production Postgres, canlı provider, gerçek SMTP/Telegram denetimi yapılmadı. “Açık yok” garantisi verilmez.

## 8. Başlangıç öncelik sırası

1. Test ve live komutlarında fail-closed ağ/LLM sınırı; çağrı sayaçlarını ölç.
2. Rate-limit atomikliği ve DB hatasında provider'a çıkmama.
3. `verify:all` — offline kontroller, ayrı status'ler, kapsam/kalite kaynakları ve kalıcı olmayan rapor.
4. Kaynak/fixture envanterini gerçek snapshot provenansı ve `unknown` runtime durumuyla raporla.
5. E2E'yi izole test DB + tek kullanımlık kimlikle çalıştır; browser yoksa BLOCKED.
6. Gerçek etiketli dataset, resmi live source/LLM ve ToS doğrulaması yetkili operatör ortamı olmadan tamamlanamaz.

## 9. Tur sonu (2026-10-17)

**Son kod doğrulaması:** `npm run verify:all` exit **0**, `PASS_OFFLINE_CHECKS`. Güncel rapor ve alt loglar: `artifacts/verify-all/2026-10-17T14-18-50-814Z/` (`report.json` içindeki HEAD=`23411a6100fb4f06cb47ab5457917441852741ac`; koşum sırasında E2E bootstrap değişikliği çalışma ağacındaydı ve ayrıca izole `seed:e2e-sources` komutuyla doğrulandı). Dokuz adımın tümü exit 0: typecheck, ESLint, tam Vitest, coverage, production build, env check, offline statik envanter/fixture sözleşmesi, deterministik eval ve LLM doctor `--offline`. Coverage komutu ile tam Vitest: **107 dosya / 1.305 test geçti**; başarısız/atlanan test raporlanmadı. `git diff --check` exit 0. Son commit'teki ağaç için GitHub Actions CI run `39040669032` tüm adımları geçti; Playwright **20/20**.

| Son katman | Sonuç | Kanıt sınırı |
|---|---|---|
| Dependency install/audit | `npm ci` exit 0; 387 paket kuruldu, 388 paket denetlendi, 0 vulnerability | npm registry kurulum/audit kanıtıdır; SAST/secret scan değildir. |
| Coverage | statements **%77,25**, branches **%67,56**, functions **%73,55**, lines **%79,86** | Baseline'a göre sırasıyla **−0,14 / −0,12 / +0,52 / −0,07 yüzde puan**. Eşik değiştirilmedi; bu küçük değişimler gerçek kalite regresyonu/iyileşmesi iddiası değildir. |
| Kaynak ve fixture statik sözleşmesi | PASS; 28 kaynak, 24 etkin, 10 adapter, 4 planlı; unique key/adapter/allowlist hatası yok; fixture `none`, **0 snapshot** | Live fetch yapılmadı. Kaynak sağlığı `UNKNOWN`, son HTTP ve sıfır sonuç nedeni `NOT OBSERVED`. |
| Sınıflandırma ve alan çıkarımı | Deterministik komut exit 0; 17 `spec-title`, **0 real**, **0 human-real**, `sufficient=false`, sınıf başı asgari 20 | Sentetik/başlık regresyon oranları gerçek precision/recall değildir. İnsan doğrulamalı `expectedFields` yok; extraction accuracy **ölçülmedi**. |
| LLM doctor/provider | Offline doctor exit 0; **0/5** provider çağrısı; classifier/assistant attempted=false; gerçek provider maliyeti **$0** | Gerçek fiyat, erişim, LLM kalite veya fatura ölçümü değildir. |
| Offline ağ/DB/bildirim | 10 dış HTTP/soket denemesi dışarı çıkmadan engellendi: raw HTTP 2, raw socket 2, source HTTP 4, global fetch 2 (`example.invalid`, `issuer.example.invalid`). Gerçek dış kaynak/provider isteği **0**, gerçek bildirim **0**, production DB write **0**. TLS doğrulaması açık; live fetch/browser/AIA/scheduler/AI kapalı; DB=file; provider/DB credentialları child env'den silindi. | Engellenen denemeler güvenlik regression testleridir, gerçek host sağlığı değildir. Loopback/fake testleri korunur. |
| Playwright E2E/security | Local `verify:all` **BLOCKED** — Chromium yok (`/home/user/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`). Draft PR #22 CI run `39040669032` PASS; **20/20 E2E testi geçti** (`e2e/security.spec.ts` dahil). İlk run `39039669555` 19/20'de, boş test DB'sinde statik kaynak eksikliği nedeniyle kaldı. | `seed:e2e-sources` yalnız izole file-backed test deposuna statik kaynak tanımları yazar; CI düzeltmesi doğrulandı. Yerel `BLOCKED`, CI PASS olarak ayrı tutulur. |

### Uygulanan iş ve faz durumu

- **S1 — offline izolasyon: DONE.** CI ve `verify:all` test/live kaynakları, AI, scheduler, gerçek mail, production DB credentiallarını kapatır; Vitest raw/global HTTP(S), TCP/TLS ve global fetch'i guard eder. Test DB yolu her test süreci için geçicidir; test `APP_SECRET` sabittir, proxy env temizlenir. Enjekte gerçek Undici Agent engellenir; `MockAgent.disableNetConnect()` zorlanır; loopback fixture korunur.
- **S2 — live komutları: IMPLEMENTED / NOT RUN.** `test:live` yalnız `--live` + tek `--source` ya da `--all` ve zorunlu request/page/detail/delay sınırlarıyla çalışabilir. Doctor varsayılan offline; live çağrısı `--live`, calls/tokens/USD bütçesi ve resmi pozitif fiyat varsayımları ister. Eval ve review-assist açık veri paylaşım bayrağı ve limit olmadan provider'a gitmez. Bu oturumda hiçbir live komut çalıştırılmadı.
- **S3/S7 — AI maliyeti/kota ve rate-limit: DONE (unit/PGlite kanıtıyla).** Koşu/gün USD rezervasyonu ve global/scoped çağrı sayaçları atomik, worker'lar arası ortak; Postgres/file atomik artırma ve fail-closed storage testleri var. MongoDB uygulaması mevcut ancak gerçek Mongo instance'ında denenmedi. Üretimde iki pozitif resmi fiyat varsayımıyla koşu+24s USD cap zorunlu; tavan bir fatura garantisi değil.
- **S4/S9 — gerçek kalite kalibrasyonu/alan doğruluğu: INSUFFICIENT DATA.** İnsan etiketli gerçek kayıt 0; alan doğruluğu ölçülmedi; eşik oynanmadı ve uydurma etiket eklenmedi.
- **S5 — canlı kaynak sağlığı: BLOCKED / NOT RUN.** Yetkili dış kaynak kontrolü ve insan onaylı fixture snapshot'ı yok; statik envanter dışında health iddiası yok.
- **S6 — fixture sözleşmesi: DONE (sentetik contract testleri); gerçek fixture: NONE.** Manifest; allowlist hostu, source key+tarih dosya adı, query/fragment'siz provenance, HTTP/status/type/bytes/SHA-256/redaction/protocol, normal depo-içi dosya ve manifest-dışı HTML/JSON dosyası kontrollerini yapar. Capture tek source/tek listing request, en fazla 5 MB, redaction+manuel PII/lisans/ToS incelemesi gerektirir. Bu araçla bu turda veri yakalanmadı.
- **S8 — E2E/security: CI PASS / local BLOCKED.** Yerel browser yok. İlk PR CI run `39039669555` 19 geçti/1 kaynak-listesi senaryosu boş test DB'si nedeniyle kaldı; `seed:e2e-sources` ile yalnız `NODE_ENV=test` + file DB'ye statik kaynak tanımı yazan, worker/ağ başlatmayan fail-closed bootstrap eklendi. İzole elle koşum exit 0 (28 tanım), `SOURCE_LIVE_FETCH=1` koşumu DB oluşturmadan reddedildi (script exit 1). İkinci CI run `39040669032` PASS; Playwright 20/20, güvenlik E2E'si dahil.
- **S10 — robots/ToS/runtime uyumu: BLOCKED / operator gate.** Otomatik robots/ToS enforcement eklenmedi; her live fetch/capture öncesi yetkili kişi şartları incelemeli. CAPTCHA/WAF/auth/rate limit aşılmaz.

**Açık risk / kapsam dışı:** Tam SAST/secret scan, canlı Supabase/Postgres RLS ve Mongo, gerçek SMTP/Telegram, provider billing verification ve OWASP/ASVS audit yapılmadı. `npm ci`'nin 0 vulnerability çıktısı bunların yerine geçmez. Implementation commit `23411a6` (`security: isolate offline verification and bound AI budgets`) ve CI düzeltme commit'i `8a3f6a3` (`test: seed static source inventory for E2E`) `arena/2829bca7-kamuradar` dalına push edildi; draft PR [#22](https://github.com/kaaradumaann-psi/kamuradar/pull/22) açık, merge yok. İlk run `39039669555` 19/20 E2E'de kaldı; düzeltme sonrası `39040669032` tüm CI adımları ve Playwright 20/20 ile geçti. GitHub Actions annotations ayrıca `actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4` için Node.js 20 deprecation warning'ini (runner şu an Node 24 ile çalıştırıyor) bildirdi; non-blocking uyarıdır, action migration ayrı bakım işidir. Merge kararı E2E CI kapısı geçtiği için mümkün hale geldi; ancak gerçek etiket/kaynak, provider/fatura, production DB/Mongo ve robots/ToS kanıt kapıları hâlâ `INSUFFICIENT DATA`/`BLOCKED` olduğundan bu PR draft tutuldu ve merge edilmedi.

Baseline değerleri (bölüm 2) değişiklik öncesi tarihsel ölçüm olarak korunmuştur.
