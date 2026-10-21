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
| 14 | Tarayıcı E2E (CI) | GitHub Actions `verify` işi | **PASS** | 4 spec / 20 test; adımlar `Playwright tarayıcıları` + `Uçtan uca testler` = success (run `39597847874`, commit `911b0b4`) |

**Son doğrulayıcı raporu:** `artifacts/verify-all/2026-10-21T12-20-51-914Z/report.json`
(`status: PASS_OFFLINE_CHECKS`, 122 dosya / 1.409 test, kapsam %77,52).
Önceki koşum: `artifacts/verify-all/2026-10-21T11-55-04-414Z/report.json`.
Raporun kendi kanıt satırları (her iki koşumda aynı):
- `Dış HTTP guard: 12 engellenen deneme; gerçek outbound çağrı 0`
- `Gerçek-insan etiketi: 0` · `LLM doctor çağrısı: 0`
- `Kaynak envanteri: 28 kaynak, 24 etkin, fixture none`

## 2. Çalıştırılamayanlar (dürüst liste)

| Kontrol | Durum | Neden | Nasıl kapanır |
| --- | --- | --- | --- |
| Playwright E2E — **yerel sandbox** | **BLOCKED** | Chromium ikilisi yok (`/home/user/.cache/ms-playwright/.../chrome` mevcut değil). **CI'da aynı testler geçiyor** (bkz. §1 satır 14) | Yerelde `npx playwright install chromium` |
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

## 6. Bağımsız yeniden doğrulama (Claude Code, 21.10.2026)

**Kapsam:** PR #25 (`arena/244c8afc-kamuradar`, head `739eee3`) Arena'dan bağımsız olarak
yeniden koşuldu. Ortam: Windows 11, Node 24.21.0, `npm ci` (kilit dosyasıyla).
Yerel `D:\coding\claude\Kamuİlan` klasörü git deposu değil; içeriği `main` @ `4fd9acb` ile
birebir aynı (yalnızca `.git` farkı) — düzeltmeler orada yok.

### 6.1 Testler hatayı gerçekten yakalıyor mu? (mutasyon kontrolü)

PR'ın eklediği 8 test dosyası **düzeltme öncesi** `main` kaynağına karşı koşuldu:
**18/36 test başarısız** (7 dosya kırmızı). Her düzeltmenin en az bir testi eski kodda
kırılıyor → testler hata sınıfını yakalıyor [2].

| Düzeltme | Eski kodda kırılan test |
| --- | --- |
| İptal hedefi + iptal sinyali | 3 (`ilan-iptal-guvenligi`: ilgisiz ilanı kapatma ×2, "İptal İlanı (…)" biçimi) + 1 (`gercek-ilan-regresyon`: gerçek iptal duyuruları) |
| Haber dili | 4 |
| `unsubscribe` CSRF | 1 (başlıksız oturumlu çıkış 403) |
| `hasApplicationUrl=false` | 1 |
| `$exists` | 3 |
| Vekil IP | 5 (`buildForwardHeaders` eski kodda yok — davranış değil, dışa aktarım eksikliği nedeniyle kırılır) |

**Düzeltme:** §4'teki "Gerçek kaynak" satırı bir *düzeltme kanıtı* değildir:
`tests/gercek-kaynak-icisleri-regresyon.test.ts` eski kodda da 4/4 geçiyor. Bu dosya
mevcut davranışın temel çizgisidir.

### 6.2 Yeni bulgu: haber kapısı gerçek ilanları reddediyordu (P1, düzeltildi)

Depodaki tüm test başlıkları ve eval kayıtları (205 kayıt) eski ve yeni motorla
sınıflandırıldı. Kararı değişen kayıtlar yalnızca PR'ın kendi 7 haber başlığı oldu.
Ancak elle yazılmış ilan biçimli örneklerle yapılan prob şu yan etkileri gösterdi:

| Başlık (gövde: standart ilan metni) | `main` | PR #25 | Bu düzeltme |
| --- | --- | --- | --- |
| Müdür Yardımcısı Alım İlanı | accept | **reject** | accept |
| Vali Yardımcısı Kadrosu Personel Alımı | accept | **reject** | accept |
| Genel Müdür Alımı İlanı | review | **reject** | review |
| Başkan Yardımcısı (Sözleşmeli) Personel Alımı (+ tarih) | accept | review | accept |
| Sürekli İşçi Alımı İlanı Hakkında Açıklama | accept | **reject** | review |

Kök neden: `haber.konusmaci-aktarimi` kalıbı ünvandan sonra herhangi bir sözcüğü kabul
ediyordu. Düzeltme: `src/classification/rules.ts` (görev/alım sözcüğü gelirse eşleşmez;
`NEWS_GATE_AD_TITLE_PATTERN`) + `src/classification/engine.ts` (başlık "ilan" içeriyorsa
haber kapısı en fazla `review`). Test: `tests/classification-haber-dili.test.ts` +3.
**Sınır:** Örnek başlıklar elle yazıldı (gerçek kaynaktan toplanmadı) [3]; gerçek kesinlik
hâlâ ölçülmedi (R-04).

### 6.3 Komutlar (bu dal, düzeltme sonrası)

| Kontrol | Komut | Durum | Sonuç |
| --- | --- | --- | --- |
| Tip denetimi | `npm run typecheck` | **PASS** | çıkış 0 |
| Lint | `npm run lint` | **PASS** | çıkış 0 |
| Tam test (Windows) | `npx vitest run` | **PARTIAL** | 122 dosya / 1412 test: 1402 geçti, **9 başarısız**, 1 atlandı |
| 9 başarısızlığın kökü | aynı 4 dosya `main`'de | **ortam** | `main` üzerinde de aynı 9 test kırılıyor: CRLF checkout (tasarım CSS ve PDF fixture özeti), Windows yol genişletme, `staging-capture` alt süreç çıkış kodu `null`. Kod değişikliğiyle ilgisiz |
| Atlanan 1 test | `dev-all-kapanis` | beklenen | `it.skipIf(isWindows)` |
| Üretim derlemesi | `npm run build` | **PASS** | çıkış 0 |
| Bağımlılık | `npm audit --json` | **PASS** | 0 açık (npm meta toplamı 449 paket; §1'deki 402 farklı sayım yöntemi) |
| Linux CI (`verify:all` + E2E) | GitHub Actions `verify` | PR head `739eee3`: **PASS** ×2 | Bu düzeltmenin CI sonucu PR üzerinde |
| Kapsam | `vitest --coverage` | **NOT RUN** | Bu turda tekrar koşulmadı; §1 değerleri Arena ölçümü |
| Gerçek Postgres/Mongo, yük testi | — | **BLOCKED** | Bu makinede Docker/Postgres yok |
| Canlı kaynak, gerçek LLM | — | **NOT RUN (bilinçli)** | Ağ/ücret onayı yok |

### 6.4 KadroNerede kontrolü

`robots.txt` tek istekle yeniden okundu: 05 §1'deki `Disallow` listesi, `Content-Signal`
ve AI tarayıcı bloğu **gözlemlendi** (aynı). `/sitemap.xml` → 200 `application/xml`,
`/llms.txt` → 200.

### 6.5 Açık kalan güvenlik notu (R-09)

`clientIp()` `TRUST_PROXY=1` iken `X-Forwarded-For`'un **ilk** değerini alır. Vekil artık
istemci başlığını taşımıyor; fakat API kökeni (`api.kamuilan…`) doğrudan internetten
erişilebiliyorsa saldırgan vekili atlayıp sahte `X-Forwarded-For` gönderebilir.
Üretimde API'nin yalnızca vekilden erişilebilir olduğu **doğrulanmadı** [4]. Önerilen
kapanış: API'de yalnızca Cloudflare IP aralıklarından gelen isteklere güvenmek
(`trustProxy` IP listesi) ya da kökeni Cloudflare Tunnel/erişim kuralıyla kapatmak.
Dağıtım kararıdır, bu turda kod değişmedi.

## 7. R-03 ön filtre değişikliği (`fix/r03-postgres-onfiltre`, 21.10.2026)

| Kontrol | Komut | Durum | Sonuç |
| --- | --- | --- | --- |
| Tip / lint | `npm run typecheck`, `npx eslint` (değişen dosyalar) | **PASS** | çıkış 0 |
| Postgres sürücüsü (PGlite, Postgres 16 WASM) | `npx vitest run tests/postgres-store.test.ts` | **PASS** | 14/14 (2 yeni test) |
| Mutasyon kontrolü | Aynı testler eski `postgres-store.ts` ile | beklenen **FAIL** | Yeni R-03 testi "20000 satırı aştı" hatasıyla kırılıyor; rastgele fark testi eski kodda da geçiyor (doğruluk korunmuş) |
| Rastgele fark testi, ek tohumlar | 6 ek tohum × 250 sorgu (yerel, commit edilmedi) | **PASS** | 1.750 sorguda Postgres = dosya sürücüsü |
| Tam test (Windows) | `npx vitest run` | **PARTIAL** | 1414 test: 1404 geçti, 9 başarısız (§6.3'teki aynı ortam hataları), 1 atlandı |
| Gerçek Postgres/Supabase, yük süresi | — | **BLOCKED** | Postgres/Docker yok; üretim DB'ye erişilmedi |
