# Operatör PowerShell runbook — sıfırdan kanıta

Bu runbook **Windows PowerShell 7+** içindir. Sırayı atlamayın: her adımın
çıktısı bir sonraki adımın ön koşuludur. Bu depoda aşağıdaki canlı komutlar
**çalıştırılmadı**; sandbox ağ/TLS engeli nedeniyle canlı kanıt sizde üretilir.

> **Asla:** üretim `.env` değerlerini ekrana/commit'e yazmayın, testleri üretim
> DB'sine yönlendirmeyin, `NODE_TLS_REJECT_UNAUTHORIZED=0` kullanmayın, CAPTCHA/
> WAF/oturum duvarını aşmayın, hız sınırını aşmayın.

## 0. Hazırlık

```powershell
node --version          # 20+ olmalı
git status --short      # temiz olmalı; değilse kendi değişikliklerinizi inceleyin
npm ci
```

Beklenen: `npm ci` 0 ile biter; `node_modules` oluşur. Kirli ağaçta test
sayıları değişebilir; önce mevcut değişiklikleri kaydedin/inceleyin.

## 1. Tek komutla çevrimdışı doğrulama

```powershell
npm run verify:all
$LASTEXITCODE
```

Beklenen: `verify:all PASS (offline checks)`, exit **0**, rapor:
`artifacts/verify-all/<zaman>/report.json`. Rapor `testSummary.tests` ve
`testSummary.coverage` alanlarını içerir (varsa). `E2E: BLOCKED/NOT RUN` normaldir;
bu adım Playwright çalıştırmaz.

Ayrıntılı adımlar (gerekirse):

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

## 2. E2E (tarayıcı varsa)

```powershell
npx playwright install chromium
npm run test:e2e
```

Beklenen: Chromium kurulur, E2E geçer. Kurulamıyorsa sonuç **BLOCKED**'dır;
"geçti" demeyin. E2E güvenlik testleri `e2e/security.spec.ts` içindedir.

## 3. Kaynak erişim şartlarını inceleyin (ağa çıkmadan)

`config/source-terms.json` içindeki her kaynak için:

1. `robots.txt` ve kullanım şartlarını tarayıcıda açın.
2. Okuma izni **ve** saklama izni ayrı sorulardır; emin değilseniz `blocked`
   bırakın.
3. Yalnızca insan incelemesi tamamlanan kaydı `allowed` yapın:
   `reviewedBy`, `reviewedAt`, `robotsUrl`, `termsUrl`, `allowsStorage: true`.

Kılavuz: [SOURCE-TERMS.md](./SOURCE-TERMS.md). Bu dosya commit edilirse kişisel
veri/hesap bilgisi içermediğinden emin olun.

## 4. Kuru çalışma (varsayılan; ağ yok)

```powershell
npm run staging:capture -- --source=resmigazete-cestili-ilanlar --dry-run
```

Beklenen: exit **0**, `KURU ÇALIŞMA` özeti, yalnızca
`.staging/<kaynak>-<zaman>/report/staging-report.json` ve `summary.txt` yazılır.
`http.requestsMade = 0`, `zeroResultReason = "dry-run"`, `terms.status = "unknown"`
(henüz incelemediyseniz) normaldir.

## 5. Tek kaynaklı, bütçeli canlı staging (yalnız onaydan sonra)

Ön koşullar: adım 3'te kaynak `allowed`; `--live` açık; TLS kapalı değil;
üretim DB değişkenleri **boş**.

```powershell
# Üretim DB işaretlerini bu kabukta temizleyin (değerleri yazdırmadan)
Remove-Item Env:POSTGRES_URL,Env:DATABASE_URL,Env:MONGODB_URI -ErrorAction SilentlyContinue
$env:DATABASE_DRIVER = 'file'

npm run staging:capture -- --source=resmigazete-cestili-ilanlar --live `
  --max-requests=5 --max-pages=3 --max-details=1 --min-delay-ms=1500
$LASTEXITCODE
```

Beklenen: JSON raporda `mode:"live"`, `isolation.databaseDriver:"file"`,
`productionDatabase:"NOT USED"`, gerçek `http.requestsMade`,
`run.completion` (`complete/partial/unknown`), `zeroResultReason`.
0 sonuç **başarı değildir**; neden `not-observed`/`blocked`/`parse-failure`/
`unknown` olarak yazılır. Yalnızca tam kapsam + insan onayı varsa
`--confirmed-empty` eklenir.

Çıkış kodları: `0` tamam, `1` koşum hatası, `2` kullanım hatası, `3`
allowlist/TLS/test ortamı reddi, `4` üretim DB değişkeni veya geçersiz şartlar
dosyası, `5` insan onayı olmadan canlı koşum. Ayrıntı:
[STAGING-RUNBOOK.md](./STAGING-RUNBOOK.md).

## 6. Etiketleme sayfasını üretin (izole dosya deposu)

```powershell
New-Item -ItemType Directory -Force artifacts,data | Out-Null
npm run eval:build-set -- --data-dir=artifacts/staging-db --out=data/eval-worksheet.json
```

Beklenen: kayıt sayısı, gerçek/sentetik dağılımı, hedef 145. Komut kuru
çalışır; `--apply` olmadan hiçbir şey yazmaz. `--data-dir` verilirse
`POSTGRES_URL/DATABASE_URL/MONGODB_URI` doluysa komut **reddeder**; dizin var
olmalıdır.

## 7. İnsan etiketleme

1. Her kaydın `url` alanını **resmî kaynaktan** açın.
2. `expectedContentType` + `expectedFields` + `labeledBy` + `labeledAt` doldurun.
3. Gerçek kayıt için `labelEvidence` (resmî URL + en az 20 karakter birebir
   alıntı) zorunludur.
4. Makine tahminini `expected*` alanına **kopyalamayın**; tuzakları `caseTags`
   ile işaretleyin.
5. Liste alanlarını kanonik değerlerle yazın (`["lisans"]` gibi); serbest metin
   yanlış eşleşmeye yol açar.

Şema ve tuzaklar: [LABELING-RUNBOOK.md](./LABELING-RUNBOOK.md).

## 8. İçe aktarma ve doğrulama

```powershell
npm run eval:build-set -- --data-dir=artifacts/staging-db --import data/eval-worksheet.json
# rapor temizse:
npm run eval:build-set -- --data-dir=artifacts/staging-db --import data/eval-worksheet.json --apply
```

Beklenen: reddedilen her kayıt nedeniyle listelenir; sessiz atlama yok. 145
gerçek kayıt tamamlanmadan ölçüm **INSUFFICIENT DATA** kalır.

## 9. Çevrimdışı ölçümler

```powershell
npm run eval:classification -- --json artifacts/eval-classification.json
npm run eval:extraction -- --json artifacts/eval-extraction.json
```

Beklenen: insan etiketi yoksa `INSUFFICIENT DATA` (exit 0), yüzdeler `—`.
Sınıflandırma ve alan çıkarımı **ayrı** raporlardır; biri diğerinin yerine
geçmez. Ayrıntı: [EXTRACTION-EVAL.md](./EXTRACTION-EVAL.md).

## 10. Sağlayıcı (AI) kontrolü — varsayılan kapalı

```powershell
npm run llm:doctor -- --offline --json artifacts/llm-doctor-offline.json
```

Beklenen: `usedCalls: 0`. Canlı smoke **ancak** fiyat resmî dokümandan
doğrulandıktan sonra, tek çağrıyla:

```powershell
npm run llm:doctor -- --live --max-calls=1 --max-output-tokens=64 `
  --max-estimated-cost-usd=0.01 --json artifacts/llm-doctor-live.json
```

Fiyat/model doğrulaması: [AI-MODEL-COST.md](./AI-MODEL-COST.md). Bu komut bu
depoda **çalıştırılmadı**; sonuç `NOT RUN`'dır. Sağlayıcı hatası/boş yanıt/geçersiz
JSON ayrı raporlanır; sessiz retry yoktur.

## 11. Raporlar ve hata bildirimi

| Dosya | İçerik |
|---|---|
| `artifacts/verify-all/<zaman>/report.json` | adımlar, `testSummary`, izolasyon, E2E durumu |
| `artifacts/verify-all/<zaman>/*.log` | komut çıktıları (ANSI renkli olabilir) |
| `.staging/<kaynak>-<zaman>/report/staging-report.json` | bütçe, HTTP sayaçları, kapsam, 0-sonuç nedeni |
| `artifacts/eval-classification.json` | sınıf metrikleri, insan-etiket yeterliliği |
| `artifacts/eval-extraction.json` | alan metrikleri, kanıt/tarih kontrolleri |
| `artifacts/llm-doctor-offline.json` | 0 çağrı kanıtı |

Hata bildirirken: komut, exit kodu, rapor yolu ve **maskeli** hata sınıfını
paylaşın. `.env`, API anahtarı, ham ilan gövdesi, e-posta/telefon/TCKN veya
üretim URL kimlik bilgisi göndermeyin.

## 12. Bitiş kontrol listesi

- [ ] `npm run verify:all` exit 0
- [ ] `npm run eval:extraction` durumu dürüst (`INSUFFICIENT DATA` ise öyle)
- [ ] Staging raporu `databaseDriver=file`, `productionDatabase=NOT USED`
- [ ] Canlı koşum yalnız `allowed` kaynakta ve bütçeli
- [ ] 0 sonuç "başarı" sayılmadı
- [ ] AI çağrısı 0 (veya tek bounded smoke, ayrı rapor)
