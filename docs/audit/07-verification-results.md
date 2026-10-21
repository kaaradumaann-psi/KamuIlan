# 07 — Doğrulama Sonuçları

**Koşum tarihi:** 21.10.2026, ~11:32–12:05 (TR) · **Dal:** `arena/244c8afc-kamuradar`
**Temel commit:** `4fd9acbb376316cf9e4a53bfd420cc8f385b46dc` (+ bu dalın düzeltmeleri, commit edilmeden önce)

> Her satır gerçekten çalıştırıldı. Durumlar: **PASS / FAIL / BLOCKED / NOT RUN**.
> "Test var" ≠ "test geçti"; "derleniyor" ≠ "üretime hazır".

## 1. Otomatik kontroller

| # | Kontrol | Komut | Durum | Sonuç |
| --- | --- | --- | --- | --- |
| 1 | Tip denetimi | `npm run typecheck` | **PASS** | çıkış 0, 13,1 s |
| 2 | Lint | `npm run lint` | **PASS** | çıkış 0, 8,0 s |
| 3 | Tam test kümesi | `npx vitest run` | **PASS** | **122 dosya / 1409 test**, 0 başarısız, 134–135 s |
| 4 | Kapsam | `npx vitest run --coverage` | **PASS** | %77,52 ifade · %68,06 dal · %73,69 fonksiyon · %80,07 satır |
| 5 | Üretim derlemesi | `npm run build` | **PASS** | `tsc --noEmit && vite build`, çıkış 0, 14,0 s |
| 6 | Ortam denetimi | `npm run env:check` | **PASS** (uyarı) | `ADMIN_EMAIL`/`ADMIN_PASSWORD` tanımsız uyarısı — gizli değer yazılmadı |
| 7 | Kaynak/fixture sözleşmesi | `verify:all` adımı | **PASS** | 28 kaynak · 24 etkin · 10 adaptör · eksik adaptör yok · allowlist dışı host yok |
| 8 | Deterministik sınıflandırma/çıkarım eval | `verify:all` adımı | **PASS** | Sentetik set; kesinlik iddiası yok |
| 9 | Alan çıkarımı eval | `verify:all` adımı | **PASS** | "human labels only" — insan etiketi 0 olduğu için metrik yok |
| 10 | LLM doktoru | `verify:all` adımı | **PASS** | **0 çağrı**, 0 ücret |
| 11 | Bütünleşik doğrulayıcı | `npm run verify:all` | **PASS** | `status: PASS_OFFLINE_CHECKS`, çıkış 0 |
| 12 | Bağımlılık güvenliği | `npm audit` | **PASS** | üretim 160 + geliştirme 242 paket → **0 bilinen açık** |
| 13 | Lisanslar | `node_modules` taraması | **PASS** | MIT 19 · Apache-2.0 2 · BSD-2-Clause 1 · MIT-0 1 · copyleft yok |

**Doğrulayıcı raporu:** `artifacts/verify-all/2026-10-21T11-55-04-414Z/report.json`
Raporun kendi kanıt satırları:
- `Dış HTTP guard: 12 engellenen deneme; gerçek outbound çağrı 0`
- `Gerçek-insan etiketi: 0` · `LLM doctor çağrısı: 0`
- `Kaynak envanteri: 28 kaynak, 24 etkin, fixture none`

## 2. Çalıştırılamayanlar (dürüst liste)

| Kontrol | Durum | Neden | Nasıl kapanır |
| --- | --- | --- | --- |
| Playwright E2E (`npm run test:e2e`) | **BLOCKED** | Chromium ikilisi yok (`/home/user/.cache/ms-playwright/.../chrome` mevcut değil) | CI'da `npx playwright install chromium` |
| Canlı kaynak taraması (`npm run test:live`) | **NOT RUN** | Bu ortamda dış ağ yalnızca paket depolarına açık; kaynak sitelere istek atılmadı | Üretim benzeri ortamda, kaynak başına tek istek |
| Gerçek LLM çağrısı | **NOT RUN (bilinçli)** | API anahtarı yok; ücret doğurur | Anahtar + bütçe onayı ile `npm run llm:doctor -- --live` |
| Gerçek Postgres/Mongo | **NOT RUN** | Sunucu yok; sürücü testleri taklit düzeyinde | Docker/CI servis konteyneri |
| Üretim sağlığı | **NOT RUN** | Üretim adresine erişilemedi | `curl /api/health` + `/api/health/worker` |
| Yük/ölçek testi (10k+ ilan) | **NOT RUN** | Sentetik yük senaryosu yok | 50.000 kayıtlı test veritabanı |

## 3. Bu denetimde eklenen 36 testin sonucu

| Test dosyası | Test | Sonuç |
| --- | --- | --- |
| `tests/ilan-iptal-guvenligi.test.ts` | 6 | **PASS** |
| `tests/guvenlik-cikis-csrf.test.ts` | 3 | **PASS** |
| `tests/api-filtre-sozlesmesi.test.ts` | 3 | **PASS** |
| `tests/sorgu-motoru-exists.test.ts` | 4 | **PASS** |
| `tests/vekil-istemci-ip.test.ts` | 5 | **PASS** |
| `tests/gercek-ilan-regresyon.test.ts` | 5 | **PASS** |
| `tests/classification-haber-dili.test.ts` | 6 | **PASS** |
| `tests/gercek-kaynak-icisleri-regresyon.test.ts` | 4 | **PASS** |

## 4. Düzeltmelerin gerçekten işe yaradığının kanıtı

| Düzeltme | Önce (ölçülen) | Sonra (ölçülen) |
| --- | --- | --- |
| İptal hedefi | İlgisiz ilan kapanıyor (`candidates[0]`) | Kanıt yoksa kapanmıyor → `review` |
| `hasApplicationUrl=false` | `true` gibi davranıyordu (ters filtre) | Doğru yönde filtreliyor (uçtan uca `GET /api/jobs`) |
| `$exists:false` | Alanı **olan** belgeleri de eşliyordu | İki yönlü doğru (3 sürücü ortak) |
| Vekil IP | İstemci `x-forwarded-for` taşıyabiliyordu | Yalnızca `cf-connecting-ip` |
| `unsubscribe` CSRF | Muaf → zorla çıkış mümkün | Muafiyet kaldırıldı; jetonlu akış çalışıyor |
| Haber dili | 9/9 haber başlığı `accept` | 0/9 kabul; 3 gerçek ilan hâlâ `accept` |
| Gerçek kaynak | 10 İçişleri duyurusundan 4'ü `process` (iş ilanı değil) | Aynı 4 kayıt `process` etiketiyle; hiçbiri `job` değil |

> **Not:** "Sonra" sütunu yalnızca **sentetik/gözlemlenmiş** örneklerde ölçüldü. Gerçek dünya
> kesinliği ölçülmedi (bkz. 03/R-04, 06/P1-3).

## 5. Ortam bilgisi

| | |
| --- | --- |
| Node | 22 (sandbox) |
| Paket yöneticisi | npm, `package-lock.json` kilitli |
| Veri deposu (test) | `file` (`FileStore`), geçici dizin |
| `.env` | yerel geliştirme; `SCHEDULER_ENABLED=0`, `SOURCE_LIVE_FETCH=0`, `AI_ASSISTANT_ENABLED=0`, `LLM_CLASSIFIER_ENABLED=0` |
| Gizli değer | **Hiçbiri yazdırılmadı**; yalnızca değişken adları raporlandı |
