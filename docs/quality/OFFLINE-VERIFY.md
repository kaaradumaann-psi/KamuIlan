# Çevrimdışı doğrulama ve kanıt sözleşmesi

Bu depo için tek komutlu yerel kontrol `npm run verify:all`'dır. Komut plan değil, tekrar çalıştırılabilir doğrulama koşumudur; tüm alt süreçleri izole eder ve başarısız adımları gizlemeden raporlar.

## Komut ve çıktı

```bash
npm run verify:all
```

Her koşum `artifacts/verify-all/<UTC-zamanı>/` altında `report.json`, `summary.md` (insan okur özet), `source-matrix.md` (kaynak kapsam matrisi), alt komutların ayrı stdout/stderr günlükleri, statik kaynak envanteri, deterministik sınıflandırma raporu, **insan etiketli alan çıkarımı** raporu ve **offline** LLM doctor raporu üretir. `artifacts/` Git dışında tutulur. Hata günlüklerini paylaşmadan önce gözden geçirin; test/fixture metni içerebileceğinden CI yalnızca sınırlı JSON/Markdown kanıt dosyalarını yükler, stdout/stderr günlüklerini yüklemez. Son rapordaki `steps[].exitCode` her alt komutun gerçek çıkış kodudur. Herhangi bir zorunlu kontrol başarısızsa komut çıkış kodu 1; TLS doğrulaması baştan kapalıysa hiçbir alt süreç başlamadan `BLOCKED` ve çıkış kodu 2 döner.

## İzolasyon garantileri

`verify:all` alt süreçleri:

- `NODE_ENV=test`, `DATABASE_DRIVER=file`, geçici `DATA_DIR` ve rastgele geçici `APP_SECRET` kullanır; Postgres/Mongo/Supabase/Redis bağlantı adresleri ve anahtarları alt süreç ortamından çıkarılır.
- Canlı kaynak, tarayıcı yedeği, AIA TLS ek isteği, zamanlayıcı, AI/LLM kapısı ve gerçek Resend/SMTP taşıyıcılarını kapatır. `llm:doctor` açıkça `--offline` çalıştırılır; değerlendirme LLM bayrağı olmadan yapılır.
- Vitest başlangıç kancası global `fetch`, ham `node:http`/`node:https`, `net` ve `tls` dış bağlantılarını dış host için soket açılmadan reddeder. Enjekte edilmiş gerçek Undici Agent de engellenir; açıkça enjekte edilen `MockAgent` için `disableNetConnect()` zorlanır. Yerel loopback fixture sunucuları ve mock'lar kullanılabilir. `HttpClient`, provider ve posta taşıyıcılarında ayrıca fail-closed test kontrolleri bulunur.
- Uygulama veritabanı için dosya sürücüsü kullanır. Postgres `init()` yalnızca `SELECT 1` yapar; şema DDL'i ayrı `ensureIndexes()` adımındadır. Mongo `init()` ping ile sınırlıdır; indeks/validator DDL'i `ensureIndexes()` adımındadır.

`summary.md` yalnızca gerçekten çalıştırılan adımları, test/kapsam sayılarını, kaynak/fixture sayılarını ve BLOCKED/INSUFFICIENT DATA durumlarını taşır; ham ilan metni, URL query'si veya sır içermez.

Rapor `isolation` nesnesinde gerçek sağlayıcı/kaynak/e-posta çağrısı ve production DB yazma sayısını sıfır olarak bildirir. Engellenen dış denemeler host + kanal düzeyinde ayrıca sayılır; URL, gövde, başlık, anahtar veya kişisel metin kaydedilmez. Bu güvence **CI/offline doğrulama içindir**; live komutların bilerek çalıştırılması ayrı opt-in ve ayrı kanıttır.

## Sonuçlar nasıl okunur?

- **Statik kaynak envanteri:** kaynak tanımı/anahtarı, adapter kaydı, allowlist ve fixture-manifest/hash sözleşmesini denetler. Canlı HTTP, son çalışma, ilan sayısı veya kaynak sağlığı kanıtlamaz; bunları `NOT RUN`, `UNKNOWN`, `NOT OBSERVED` olarak bırakır.
- **Fixture sözleşmesi:** yalnızca `fixtures/html/manifest.json` içinde kaynak, tarih, HTTP status, HTML/JSON türü, boyut, SHA-256, redaction notu ve depo içi normal dosya yolu doğrulanmış snapshot'ları sayar. Dosya adı kaynak anahtarı + capture tarihiyle eşleşmeli; manifest dışındaki HTML/JSON dosyaları ve query/fragment içeren provenance URL'leri reddedilir. PDF, hash'i tutmayan veya `redacted` beyanı eksik fixture kabul edilmez. Otomatik scrub kusursuz değildir; canlı sayfayı commit etmeden önce PII, lisans ve kaynak kullanım şartları insan tarafından incelenmelidir.
- **Sınıflandırma/alan çıkarımı:** `npm run eval:classification` salt deterministik kuralları ve sabit fixture kümesini ölçer. Gerçek kaynak kaydı ve `origin: "real"` + insan tarafından doğrulanmış `labelProvenance: "human"` yoksa sonuç **VERİ YETERSİZ / INSUFFICIENT DATA**'dır; sentetik/spec-title yüzdeleri gerçek doğruluk diye sunulmaz. `expectedFields` yoksa extraction accuracy ölçülmüş sayılmaz. Eşikler ölçülmüş regresyon olmadan değiştirilmez.
- **LLM doctor:** offline raporda modelin gerçek provider çağrısı yapılmış gibi gösterilmez. Anahtar/model yoksa `NOT CONFIGURED`/`UNKNOWN` normal bir live-evidence engelidir; internet denemesi değildir.
- **E2E:** güvenlik başlıkları, yetkisiz yönetici erişimi ve oturumsuz test e-postasının kuyruğa girmemesi `e2e/security.spec.ts` içindedir. Yerel `verify:all` Playwright'ı başlatmaz; CI ayrı E2E adımında izole file DB, geçici yönetici ve Chromium kullanır. `seed:e2e-sources` yalnız `NODE_ENV=test`, `DATABASE_DRIVER=file`, kapalı worker/LLM/source ve file e-posta koşullarında statik envanteri hazırlar; gerçek kaynak taraması ya da worker başlatmaz. Chromium yoksa yerel E2E **BLOCKED** diye raporlanır, geçilmiş sayılmaz.

## Gerçek kaynak doğrulaması (yalnız yetkili operatör)

Canlı komutlar otomatik kontrolün parçası değildir. PowerShell'de önce TLS doğrulamasının kapalı olmadığını ve kaynak sahibinin erişim şartlarını kontrol edin. Bir kaynağı dar kapsamla doğrulayın:

```powershell
$env:SOURCE_LIVE_FETCH = '1'
npm run test:live -- --live --source=osym-duyurular --max-requests=5 --max-pages=2 --max-details=1 --min-delay-ms=1000
Remove-Item Env:SOURCE_LIVE_FETCH
```

`--max-requests` redirect/retry dâhil toplam HTTP attempt üst sınırıdır (1–100); `--max-pages` listing/detay metin fetch üst sınırıdır (1–100); `--max-details` kaynak başına detay fetch üst sınırıdır (0–20). TLS doğrulaması açık kalır; browser ve AIA ek istekleri kapalıdır. Komut üretim DB'sini kullanmaz, bildirime çıkmaz; log/rapor ham başlık veya URL yerine sınırlı özet/hash tutar. Kaynak kimlik doğrulaması, CAPTCHA/WAF, robots veya hız sınırı aşılmaz.

Fixture yakalama ayrı ve isteğe bağlıdır; tek listing yanıtı alır, PDF/detay indirmez ve `fixtures/html/` altında yalnız yerel dosya üretir. Kullanım şartlarını ve kamuya açık veri uygunluğunu kontrol edip içeriği elle incelemeden bu dosyaları commitlemeyin:

```powershell
$env:SOURCE_LIVE_FETCH = '1'
npm run fixtures:capture -- --live --reviewed-public-data --source=osym-duyurular --max-bytes=1000000
Remove-Item Env:SOURCE_LIVE_FETCH
```

## Sağlayıcı/LLM kontrolleri (yalnız açık opt-in)

Offline doctor (JSON hedef dizinini hazırlayın):

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
npm run llm:doctor -- --offline --json artifacts/llm-doctor-offline.json
```

Tek, sabit probe istemiyle canlı provider smoke testi ancak kullanıcı verisi göndermeyen dar bir operatör koşumu olarak yapılabilir. Fiyat varsayımları sağlayıcının güncel resmi fiyatından girilmelidir; bilinmiyorsa fiyat uydurmayın ve maliyet tavanı ön kontrolü sağlayıcı çağrısını engeller:

```powershell
npm run llm:doctor -- --live --max-calls=1 --max-output-tokens=64 --max-estimated-cost-usd=0.01 --json artifacts/llm-doctor-live.json
```

Etiketli, kamuya açık olduğu incelenmiş veriyle LLM karşılaştırması açıkça onaylanır ve çağrı/token/USD tavanı gerekir. Komut e-posta/telefon/TCKN-benzeri dizileri provider metninden scrub eder; raporda kayıt kimlikleri hash'lenir. Scrub kişisel verinin tamamını bulmayı garanti etmez:

```powershell
npm run eval:classification -- --file tests/fixtures/eval/labeled-set.json --llm --reviewed-public-data --max-calls 1 --max-output-tokens 128 --max-cost-usd 0.01 --json artifacts/eval-live.json
```

İnceleme kuyruğu aracı gerçek DB'den en fazla belirtilen sayıda kaydı **okur**, provider'a gönderilmeden önce temel PII kalıplarını scrub eder, telemetriyi geçici file DB'ye yazar ve ana DB'ye değişiklik uygulamaz. `--live`, `--allow-provider-data`, kayıt/çağrı/token/maliyet sınırlarının tamamı zorunludur. Rapor kimlikleri ve metinleri hash'lenir:

```powershell
npm run llm:review-assist -- --live --allow-provider-data --max-records 5 --max-calls 1 --max-output-tokens 128 --max-cost-usd 0.01 --report artifacts/review-assist.json
```

Canlı komutların her biri için çağrı, tahmini maliyet (resmi fiyat varsayımıyla; fatura garantisi değildir), çıkış kodu ve sağlayıcı sonucu ayrı kaydedilmelidir. Gerçek insan etiketi, kaynak erişimi veya sağlayıcı kanıtı yoksa sonuç sırasıyla **INSUFFICIENT DATA** veya **BLOCKED / NOT RUN** kalır.

## İlgili kalite belgeleri

- [STAGING-RUNBOOK.md](./STAGING-RUNBOOK.md) — tek kaynaklı, izole operatör staging akışı ve çıkış kodları.
- [LABELING-RUNBOOK.md](./LABELING-RUNBOOK.md) — 145 gerçek kayıt, worksheet şeması, PowerShell sırası.
- [EXTRACTION-EVAL.md](./EXTRACTION-EVAL.md) — alan çıkarımı ölçüm yöntemi ve gerçek INSUFFICIENT DATA çıktısı.
- [EVIDENCE-MATRIX.md](./EVIDENCE-MATRIX.md) — iddia → komut → sonuç → sınır tablosu.
- [SECURITY-REVIEW.md](./SECURITY-REVIEW.md) — çalıştırılan/çalıştırılmayan güvenlik kontrolleri.
- [AI-MODEL-COST.md](./AI-MODEL-COST.md) — doğrulanmış fiyat, bütçe ve ölçüm protokolü.
- [SOURCE-TERMS.md](./SOURCE-TERMS.md) — robots/ToS insan incelemesi ve saklama kapısı.
- [PR22-POST-MERGE-REVIEW.md](./PR22-POST-MERGE-REVIEW.md) — PR #22 birleşme sonrası inceleme.
