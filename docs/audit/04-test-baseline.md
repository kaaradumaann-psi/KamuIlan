# 04 — Test ve Doğrulama Temeli

**Ölçüm tarihi:** 21.10.2026 · **Ortam:** Linux sandbox, Node 22, `node_modules` kurulu,
`.env` yerel (dosya deposu, canlı ağ kapalı, zamanlayıcı kapalı, LLM kapalı).

> Bu belge yalnızca **gerçekten çalıştırılan** kontrolleri raporlar.
> Her satır: PASS / FAIL / BLOCKED / NOT RUN. Çalıştırılmayan hiçbir test "geçti" sayılmaz.

## 1. Özet

| # | Kontrol | Komut | Sonuç | Süre | Not |
| --- | --- | --- | --- | --- | --- |
| 1 | Tip denetimi | `npm run typecheck` | **PASS** | ~13 s | 0 hata |
| 2 | Lint | `npm run lint` | **PASS** | ~8 s | 0 uyarı/hata |
| 3 | Birim + entegrasyon | `npx vitest run` | **PASS** — 122 dosya / 1409 test | ~150 s | 0 başarısız, 0 atlanmış |
| 4 | Kapsam | `npx vitest run --coverage` | **PASS** — %77,52 ifade / %80,07 satır / %68,06 dal | ~151 s | aşağıda tablo |
| 5 | Üretim derlemesi | `npm run build` | **PASS** | ~30 s | `tsc --noEmit && vite build` |
| 6 | Ortam denetimi | `npm run env:check` | **PASS** (uyarılı) | ~2 s | `ADMIN_EMAIL`/`ADMIN_PASSWORD` yok uyarısı |
| 7 | Kaynak/fixture sözleşmesi | `verify:all` içinde | **PASS** | — | fixture'lar şema + kaynak kurallarına uyuyor |
| 8 | Sınıflandırma/çıkarım eval | `verify:all` içinde | **PASS (deterministik)** | — | **Sentetik** set; kesinlik/duyarlılık iddiası yok |
| 9 | LLM doktoru | `verify:all` içinde | **PASS** | — | Anahtar yok → istek atılmadı (0 çağrı) |
| 10 | Tarayıcı E2E | `npx playwright test` | **BLOCKED** | — | Chromium ikilisi kurulu değil |
| 11 | Canlı kaynak taraması | `npm run test:live` | **NOT RUN** | — | Bu ortamda internet yalnızca paket depolarına açık; canlı tarama yapılmadı |
| 12 | Gerçek LLM çağrısı | `npm run llm:doctor` | **NOT RUN (bilinçli)** | — | Anahtar yok; ücret doğuracak çağrı yapılmadı |

`npm run verify:all` çıktısı `artifacts/verify-all/<zaman>/report.json` altına yazılır.
21.10.2026 koşumu: **`status: PASS_OFFLINE_CHECKS`, exit 0** —
`artifacts/verify-all/2026-10-21T11-55-04-414Z/report.json`.
Raporun kendi kaydı: "Dış HTTP guard: 12 engellenen deneme; gerçek outbound çağrı 0".
Yani yerel testler **ağa çıkmadı**; canlı entegrasyon kanıtı değildir.

## 2. Kapsam (dosya bazında)

| Dizin | İfade % | Dal % | Satır % | Yorum |
| --- | --- | --- | --- | --- |
| `src/ai` | 91,79 | 80,48 | 93,93 | Bütçe/zaman aşımı/JSON hataları dahil |
| `src/db/repos` | 87,23 | 78,10 | 90,67 | — |
| `src/ingest` | 91,15 | 84,44 | 93,42 | Tekilleştirme, iptal, drenaj |
| `src/extraction` | 92,76 | 80,81 | 95,40 | Tarih/kontenjan/il |
| `src/server/routes` | 70,34 | 50,10 | 71,87 | Yönetim uçlarının bir kısmı yalnızca jsdom/API düzeyinde |
| `src/db` (sürücüler) | 64,86 | 55,97 | 68,78 | Postgres/Mongo yolları kısmen test edilmiş (gerçek DB yok) |
| `src/pages` | 56,53 | 55,09 | 56,74 | UI: jsdom; gerçek tarayıcı yok |
| `src/components` | 47,38 | 47,40 | 49,48 | En düşük kapsam |
| `src/worker` | 61,68 | 58,90 | 63,69 | Zamanlayıcı yolları |
| **Toplam** | **77,52** | **68,06** | **80,07** | — |

## 3. Bu denetimde eklenen testler

| Dosya | Test | Ne kanıtlıyor | Kanıt düzeyi |
| --- | --- | --- | --- |
| `tests/ilan-iptal-guvenligi.test.ts` | 6 | İptal sinyali, kanıtla hedef seçimi, ilgisiz ilanı kapatmama | [2] |
| `tests/guvenlik-cikis-csrf.test.ts` | 3 | `unsubscribe` CSRF muafiyeti kalktı | [2] |
| `tests/api-filtre-sozlesmesi.test.ts` | 3 | `hasApplicationUrl=true/false` gerçekten ters yönlü filtreliyor | [2] |
| `tests/sorgu-motoru-exists.test.ts` | 4 | `$exists` iki yönlü (dosya/Mongo/Postgres ortak) | [2] |
| `tests/vekil-istemci-ip.test.ts` | 5 | Vekil sahte `x-forwarded-for` taşımıyor | [2] |
| `tests/gercek-ilan-regresyon.test.ts` | 5 | 20 gerçek ilan/gozlem kaydı: yanlış kabul/ret yok | [1]+[2] |
| `tests/classification-haber-dili.test.ts` | 6 | 9 haber başlığı reddediliyor, 3 gerçek ilan kabul ediliyor | [2] (başlıklar modellenmiş) |
| `tests/gercek-kaynak-icisleri-regresyon.test.ts` | 4 | 10 **gerçek** İçişleri duyurusu: hiçbiri iş ilanı değil | [1]+[2] |

## 4. Test edilmeyen / doğrulanamayan alanlar

| Alan | Durum | Neden |
| --- | --- | --- |
| Gerçek tarayıcı davranışı (klavye, odak, mobil) | **BLOCKED** | Chromium yok |
| Gerçek Postgres/Mongo davranışı | **KISMİ** | Sunucu yok; sürücüler birim testleriyle taklit ediliyor |
| Gerçek SMTP/Telegram gönderimi | **NOT RUN** | Kimlik bilgisi yok; `file` sağlayıcısıyla test ediliyor |
| Gerçek LLM yanıtı | **NOT RUN** | Anahtar yok, ücret doğurur |
| Canlı kaynak HTML'i (SSR/JS) | **KISMİ** | Fixture'lar yakalanmış örnekler; canlı ağ kapalı |
| Üretim ortamı | **NOT RUN** | Erişim yok (R-08) |
| Yük/ölçek (10k+ ilan) | **NOT RUN** | Sentetik yük testi yok (R-03) |
| KVKK silme akışının uçtan uca doğrulanması | **KISMİ** | `delete-account` ucu test edilmiş; gerçek veri silme provası yapılmadı |

## 5. Test kalitesi notları (dürüst gözlem)

1. **Mock'lar gerçek entegrasyon sayılmaz.** `tests/llm-*.test.ts` dosyaları sahte HTTP
   yanıtları kullanır; "LLM çalışıyor" kanıtı değildir. Aynı şekilde Postgres testleri
   sürücü sözleşmesini doğrular, gerçek veritabanı gecikmesini/izolasyonunu değil.
2. **Sınıflandırma eval seti sentetik** (17 kayıt) ve koşucu bunu açıkça söylüyor.
   Bu denetimde eklenen gerçek kayıtlar (20 + 10) **insan etiketli değil** (`humanVerified:false`).
3. **`kind-api.test.ts`** süreç duyurularının varsayılan listede görünmesini **bilinçli**
   doğruluyor; bu bir hata değil, ürün kararı (bkz. 03/R-12).
4. Testler `fileParallelism: false` ile sırayla koşuyor → 1409 test ~150 s. Paralel koşum
   için paylaşılan durum (dosya depoları, `.env`) ayrıştırılmalı.
