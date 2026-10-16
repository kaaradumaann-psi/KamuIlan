# Devam Notu — 16.10.2026 (Kamuİlan uçtan uca denetim oturumu)

> **Bu belge kimin için:** Önceki konuşmayı görmeyen bir yapay zekâ / geliştirici, işi buradan
> kaldığı yerden sürdürebilsin diye yazıldı. Belgede geçen her sayı ya bir komut çıktısıdır ya da
> açıkça "doğrulanmadı" diye işaretlenmiştir. Varsayım yok.

---

## 1) Projenin amacı, mimarisi ve çalışma ortamı

**Amaç:** Türkiye'deki kamu personel alım ilanlarını resmî kaynaklardan toplayan, doğrulayan,
tekilleştiren, sınıflandıran (kural motoru + iki ayrı LLM kapısı) ve e-posta/Telegram ile bildiren
platform. npm paketi: `kamuilan@0.1.0`, Node ≥ 22.15.0.

**Akış (koddaki sıra):**

1. Kaynak tanımı — `src/config/sources.ts`
2. Toplama / adaptörler — `src/sources/adapters/*` (ör. `anchor-list.ts`, `kariyerkapisi.ts`)
3. Metin seçimi + temizlik — `src/lib/html.ts` (`readableAnnouncementText`, `stripPageChrome`), `src/domain/text.ts`
4. Tekilleştirme — `src/ingest/dedupe.ts`
5. Kural motoru sınıflandırma — `src/classification/engine.ts` (karar: accept / reject / review)
6. LLM kapısı (yalnız `review` kalanlarda) — `src/ai/classifier.ts`, taşıyıcı `src/ai/llm.ts`
7. Alan çıkarımı — `src/extraction/engine.ts`
8. Kayıt + sürüm/revizyon — `src/ingest/jobs-service.ts`
9. Veritabanı — `src/db/*` (Supabase/PostgreSQL; `postgres-store.ts`)
10. Bildirim kuyruğu — `src/notifications/*`
11. Panel/API — `src/server/*` (Fastify) + Vite/React arayüz
12. Tanı/ölçüm script'leri — `scripts/*` (`tani-ilan-kalitesi.ts`, `llm-doctor.ts`, `eval-classification.ts`, `reclassify-jobs.ts`, `restore-jobs-backup.ts`)

**Çalışma ortamları (ikisi karıştırılmamalı):**

- **Kullanıcının makinesi (Windows):** `C:\Users\Halil\Desktop\kamuradar-main` — gerçek `.env` var,
  Supabase'e bağlanır, gerçek kaynak taraması yapar, gerçek `.env` değerleri yalnız orada.
- **Bu oturumun sandbox'ı:** `/home/user/kamuradar` — **`.env` YOK** (doğrulandı). Bu yüzden
  veritabanına bağlanan komutlar (`tani:ilan`, `jobs:reclassify`, `jobs:restore`, `sources:report`,
  `llm:doctor`, `eval:classification --llm`) sandbox'ta **çalışmaz**. Dış ağ erişimi yalnız
  github/npm/pypi; gerçek ilan kaynaklarına erişim yok.
- **Kural:** Üretim verisiyle ilgili her kanıt kullanıcının makinesinden gelen çıktıdır; sandbox
  yalnız kod + test kanıtı üretir.

---

## 2) Oturum başı / sonu: branch, commit, PR

| | Değer |
|---|---|
| Taban (oturum başı) | `main` = **`a777f38`** (PR #20 merge'i) |
| Çalışma dalı | **`arena/7ae2fdfa-kamuradar`** |
| Oturum başı süiti | 88 test dosyası / 1135 test |
| Oturum sonu dal ucu | **`32143be`** + bu belgeyi taşıyan commit'ler |
| Oturum sonu süiti | **102 test dosyası / 1276 test (hepsi geçti)** |
| Dal ↔ main | Dal, `origin/main`'in **22 commit önünde**, 0 commit geride (`git rev-list --left-right --count origin/main...HEAD` → `0 22`) |
| Çalışma ağacı | Temiz (`git status --short` boş) |
| PR | **#21** — https://github.com/kaaradumaann-psi/kamuradar/pull/21 (base `main`, head `arena/7ae2fdfa-kamuradar`) |
| Önceki PR'lar | #20 ve öncesi **merge edilmiş**; oturum başında açık PR yoktu (`gh pr list --state open` → boş) |

Değişiklik özeti (taban → dal ucu): **38 dosya, +6070 / −52 satır**; 17 test dosyası, 14 kaynak dosyası.

---

## 3) Bu oturumda gerçekten yapılan değişiklikler (dosya yollarıyla)

### 3.1 Üretim kodu düzeltmeleri (her biri kanıtlı, testli)

| Konu | Dosya | Test |
|---|---|---|
| Kanıtsız model özeti, bayat durum, model kaynaklı uyum derecesi | `src/ai/*`, `src/ingest/*` | `tests/senaryo-uctan-uca.test.ts` (61 senaryo) |
| Yayım tarihi yasal atıftan okunuyordu; noktalı tarih hiç okunmuyordu | `src/extraction/engine.ts`, `src/domain/dates.ts` | +11 test (`tests/yayim-tarihi-*.test.ts`) |
| Kaynağın kendi liste/dizin sayfası ilan kaydı olamaz | `src/sources/adapters/anchor-list.ts` (`isSourceListingUrl`) | +7 test |
| Desteksiz yayım tarihi + imkânsız son başvuru tarihi temizliği (veri onarımı) | `src/ingest/reclassify.ts`, `src/ingest/reclassify-batch.ts`, `scripts/reclassify-jobs.ts`, `scripts/restore-jobs-backup.ts` | `tests/yeniden-siniflandirma-tarih.test.ts` (17+ test) |
| Arayüz kabuğu (menü/çerez) temizliği gerçek kayıt gövdeleriyle genişletildi | `src/domain/text.ts` (`UI_CHROME_PHRASES`) | +4 test |
| Gövde seçimi: menü kabı ilan sanmayı bıraktı (bağlantı yoğunluğu kuralı) | `src/lib/html.ts` (`LINK_DENSE_CANDIDATE_SHARE = 0.5`, satır 216), `src/config/app.ts` (`EXTRACTION_VERSION = 2026.10.4`) | `tests/govde-secimi-menu-regresyon.test.ts` (7) + `tests/govde-iskelet-olcumu.test.ts` (10) |
| 429 kota ayırt edildi; hata metni sağlayıcıya yazıldı | `src/ai/llm.ts` (`PROVIDER_QUOTA_PATTERN`, `statusHint`) | `tests/llm-429-kota-teshisi.test.ts` (5) |
| `--json [dosya]` davranışı iki komutta birleşti (sessiz kayıp bitti) | `src/lib/json-output.ts`, `scripts/llm-doctor.ts`, `scripts/eval-classification.ts` | `tests/json-cikti-arg.test.ts` (7) |
| Kapı senaryosu kararı `uygun / UYGUNSUZ / kapı çalışmadı` olarak ayrıldı | `src/classification/eval.ts`, `scripts/eval-classification.ts` | `tests/ai-kapisi-olcum.test.ts` (5) |

### 3.2 Tanı / ölçüm araçları (salt okuma)

- `scripts/tani-ilan-kalitesi.ts` — 12 bölümlük ilan kalitesi tanısı (T1–T12 sınıfları, kaynak
  sağlığı, tarih kanıtı, AI telemetrisi, `--kaynak <anahtar>` ile tek kaynağın tam gövdesi).
- `scripts/eval-classification.ts` + `tests/fixtures/eval/ai-kapisi-senaryolari.json` (4 senaryo) ve
  `tests/fixtures/eval/ai-kapisi-tek-senaryo.json` (1 senaryo, kota kısıtlıyken tek çağrılık kanıt).
- `scripts/llm-doctor.ts` — bağlantı + basit metin üretimi kontrolü.
- `durum-kontrol.cjs` — tek komutluk güvenli durum kontrolü.

### 3.3 Raporlar

- `docs/denetim-raporu-2026-10-16-uctan-uca.md` — A–H yapılı ana rapor; **G.11, G.12, G.13**
  bölümleri bu oturumun canlı koşum kanıtlarını taşır.

---

## 4) Çalıştırılan komutlar ve gerçek sonuçlar

### 4.1 Sandbox (`/home/user/kamuradar`, bu kapanış turu, 16.10.2026)

| Komut | Sonuç |
|---|---|
| `npm run typecheck` | Hatasız (çıktı yok, çıkış kodu 0) |
| `npm run lint` | Hatasız (çıktı yok, çıkış kodu 0) |
| `npm run build` | Başarılı — `dist/` üretildi (354 ms) |
| `npm test` | **102 dosya / 1276 test geçti**, 121,0 sn, 0 başarısız |
| `git rev-list --left-right --count origin/main...HEAD` | `0	22` (dal 22 commit önde) |
| `gh pr list --state open` | Boş (açık PR yok) |

Sandbox'ta **çalıştırılamayanlar** (gerekçe: `.env` yok / gerçek ağ yok):
`npm run env:check`, `npm run sources:report`, `npm run tani:ilan`, `npm run jobs:*`,
`npm run llm:doctor`, `npm run eval:classification --llm`, `npm run test:e2e` (tarayıcı + sunucu ister).

### 4.2 Kullanıcının makinesinden gelen gerçek çıktılar (bu oturumda paylaşıldı)

| Komut / olay | Sonuç |
|---|---|
| `npm ci` | 384 paket, 0 zafiyet |
| `npm test` (oturum başı sürümü) | 1233 geçti / 23 atlandı |
| `npm run llm:doctor` | **Yeşil**: HTTP 200, 6111 ms, 2 deneme, yanıt "hazır" (24/2 token), 5/5 kontrol, `apiBudget 3/5`, model listesi 200/**63** kayıt, `gemini-3.8-flash` var |
| `npm run eval:classification -- --llm` (4'lük set) | **4/4 hata** — `429 RESOURCE_EXHAUSTED` (kota) + `503` (geçici yoğunluk) |
| `npm run eval:classification -- --file tests/fixtures/eval/ai-kapisi-tek-senaryo.json --llm` | **YEŞİL**: ok 1 · invalid 0 · error 0 · apiCalls 1 · f1 **1.0** · 4041 ms · token 1154+198 · maliyet `null` (fiyat doğrulanmadı) |
| `npm run jobs:reclassify -- --report data\reclassify-kuru.json` (kuru) | 67 kayıt → akışta **38**, reddedilecek **29**, değişecek 53, yayım tarihi silinecek 8, son başvuru silinecek 7, **bildirim 0** |
| `npm run jobs:reclassify -- --apply` | Kullanıcı koşturdu — bkz. §6 (kanıt: tanı çıktısı) |
| `npm run tani:ilan` (11:30Z) | 67 kayıt · **accept=38 · reject=29** · process=19/job=48 · yayım 2018=1, 2026=30, yok=36 · işaretli 28 · kopya grubu 0 · inceleme kuyruğu 74/75 açık |
| `npm run tani:ilan -- --kaynak kgm-duyurular` | 4 KGM kaydı; **dördünün saklanan gövdesi tam 2300 karakter ve kelime ortasında kesik** |

**Not (kanıt disiplini):** `llm:doctor` yeşil olması sınıflandırmanın çalıştığını KANITLAMAZ; kanıt,
tek senaryolu `eval`in `ok 1 · f1 1.0` sonucudur (şema + birebir kanıt doğrulaması:
`src/ai/classifier.ts:463 validateClassifierOutput`).

---

## 5) Doğrulanmış bulgular ↔ doğrulanmamış iddialar

### 5.1 DOĞRULANDI (kod okuması ve/veya komut çıktısı ile)

1. **Gövde seçimi menüyü eliyor (yeni taramalarda):** `src/lib/html.ts:216`
   `LINK_DENSE_CANDIDATE_SHARE = 0.5`; aday metin, bağlantı yoğunluğu bu eşiğin altındaysa ve
   `looksLikePageChromeText` false ise ilan gövdesi kabul edilir. Sürümler `src/config/app.ts:45` ve
   `:60` → `2026.10.4`.
2. **Eski kayıtlar kendiliğinden düzelmez:** `src/ingest/jobs-service.ts:771-820`
   (`mergeIntoExistingJob`) birleştirmede `textExcerpt` alanını **hiç güncellemez**. Bu yüzden
   `detectChanges` içindeki `compare('textExcerpt', …)` (satır 381) **ölü koddur** ve ilk görülen
   gövde kayıtta donar.
3. **KGM kayıtlarının gövdesi menü + 2300 karakterde kesik:** kanıt, kullanıcının
   `tani:ilan --kaynak kgm-duyurular` çıktısıdır (4 kayıt, dördü de `2300 karakter`, cümle
   ortasında `…`). Bugünkü kod gövdeyi 2500 karakterde sınırlar (`src/ingest/jobs-service.ts:252`),
   yani kayıtlardaki 2300 değeri 13.10.2026'daki toplamanın izidir (eski sınır bugünkü kodda yok).
4. **"26 kayıt eski kural sürümü" uyarısı aksiyon gerektirmez:** `jobs:reclassify`
   (`src/ingest/reclassify.ts:99`, `adoptNewReasons`) kararı ve türü değişmeyen kaydın kural
   sürümünü **bilinçli olarak** korur. Yani yeniden sınıflandırma bu 26 kaydın damgasını değiştirmez;
   tanıdaki "ESKİ = yeniden sınıflandırma gerekir" ifadesi yanıltıcıdır.
5. **Tarih temizliği kuralının sınırı:** `src/ingest/reclassify.ts:129-140` + satır 23
   (`PUBLISHED_DATE_REGRESSION_DAYS = 400`) yalnız `fieldSources.publishedAt.kind !== 'listing'`
   olan, metinde tarih bulunmayan ve 400 günden eski tarihleri siler. OKA'nın `2018-07-15` tarihi bu
   yüzden silinmedi (kaynağın kendi tarih katmanından gelmiş olması beklenir).
6. **Kanıt zinciri gerçek bir çağrıyla geçti:** `src/ai/classifier.ts:463 verilen şema + birebir kanıt
   + tür tutarlılığı + enjeksiyon koruması` kontrolünden geçen tek senaryolu koşum (`ok 1`, `f1 1.0`).
7. **429/503 ayrımı kodda:** `src/ai/llm.ts` `PROVIDER_QUOTA_PATTERN` + `statusHint`; 5 test.
   `--json [dosya]` davranışı `src/lib/json-output.ts` ile iki komutta birleşti; 7 test.
8. **Süit/derleme durumu:** typecheck, lint, build temiz; 102 dosya / 1276 test geçti (sandbox).

### 5.2 DOĞRULANMADI (canlı kanıt bekliyor — "doğrulanmadı" diye işaretli)

1. **OKA tarihinin kaynağı** (liste katmanı mı, detay mı?) — komut:
   `npm run tani:ilan -- --kaynak kariyerkapisi-isealim` (çıktıdaki "Yayım tarihi: … (kaynak: …)" satırı).
2. **YÖK kayıtlarındaki 2026-04-20 tarihleri** (15 kayıtta aynı tarih; tanıda T11 + "metinde
   bulunamadı"). Canlı sayfa kanıtı olmadan doğrulanmış sayılmaz; **tarih silinmedi**.
3. **KGM/TMSF/DSİ/İŞKUR gövdelerinin yeni seçiciyle düzelip düzelmediği** — canlı HTML örneği gerekir
   (kaynak adaptörü yorumları da bunu söyler).
4. **3 kaynağın 22 ardışık hatası:** `resmigazete-cestili-ilanlar` (zaman aşımı),
   `bddk-duyurular` (zaman aşımı), `saglik-bakanligi-personel` ("Liste yapısı tanınmadı") — kök neden
   için `npm run sources:report`.
5. **12 etkin kaynağın hiç kayıt üretmemesi** (ilan.gov.tr, SGK, TÜBİTAK, ÖSYM, EPDK, SPK, BDDK,
   TKGM, Sağlık, Kamuİlan-SBB, Resmî Gazete, EPDK…) — kapsam boşluğu; seçici/erişim doğrulaması yok.
6. **4'lük kapı testi** (hedef: `uygun 4 · UYGUNSUZ 0 · kapı çalışmadı 0`) — 429/503 nedeniyle
   ölçülemedi.
7. **Panel/worker uçtan uca akışı** — üretimde AI telemetrisi yalnız **2 kayıt**, ikisi de 15.10.2026
   akşamı **404** (yapılandırma hatası, sonradan düzeltildi). Panelin gerçek sınıflandırma/öneri akışı
   henüz telemetri üretmedi.
8. **Kullanıcının `--apply` yedeğinin varlığı** — `data\backups\` içeriği henüz paylaşılmadı.

---

## 6) Üretim verisinde değişiklik oldu mu?

**EVET — kullanıcının kendi makinesinde, kullanıcı onayıyla, 16.10.2026:**

- Komut: `npm run jobs:reclassify -- --apply` (kuru çalıştırma önce yapıldı ve incelendi).
- Etki: 67 kayıt → **38 kayıt akışta** (19 iş ilanı + 19 süreç duyurusu), **29 kayıt akıştan
  çıkarıldı** (kayıt **silinmedi**, yalnız karar `reject` oldu ve bildirim bastırıldı).
- Tarih alanları: **8 desteksiz yayım tarihi** ve **7 imkânsız son başvuru tarihi** `null` yazıldı
  (kayıtlar korunur).
- Bazı kayıtların türü değişti (13 kayıt job↔process), 1 başlık menü metninden temizlendi.
- **Bildirim gönderilmedi:** kuru çalıştırma raporunda tüm kayıtlar için
  `pending/sent/failed/dead/suppressed = 0` görüldü.

**Kanıt ve sınır:** Bu değişikliği sandbox'tan doğrulayamıyorum (DB erişimi yok). Kanıt,
kullanıcının paylaştığı `tani:ilan` çıktısıdır (11:30Z): `accept=38 · reject=29`, yayım yılı yalnız
`2018=1` (silinen tarihler gitti), sürüm dağılımı ve kaynak sayıları kuru çalıştırmayla tutarlı.
**Bu oturumun sandbox'ında üretim verisine hiç dokunulmadı** (yalnız kod + test + rapor).

---

## 7) Yedek konumu ve geri yükleme (komut verilir, ÇALIŞTIRILMADI)

- Yedek: `data/backups/jobs-before-reclassify-<zaman>.json` (`--apply` öncesi otomatik alınır;
  `wx` bayrağıyla yazılır, var olan dosyanın üzerine yazmaz).
- Geri yükleme komutu **önce çalıştırılmadan** (önizleme) denenebilir:

```
dir data\backups
npm run jobs:restore -- data\backups\jobs-before-reclassify-<zaman>.json
npm run jobs:restore -- data\backups\jobs-before-reclassify-<zaman>.json --apply
```

Kurallar: yalnız yedekte bulunan kimlikler geri yüklenir; yedekte olmayan kayıtlara dokunulmaz;
`--apply` öncesi mevcut durumun ayrı bir yedeği (`before-restore`) alınır (yani geri alma da geri
alınabilir). Bu komutlar bu oturumda **çalıştırılmadı**.

---

## 8) Yarım kalan işler (önem sırası)

**P0 — yok.** (Veri kaybı, yanlış uygunluk kararı, güvenlik açığı veya veri sızıntısı bulgusu yok.)

**P1 — akışı doğrudan etkiler**

1. **3 kaynak 22 kez üst üste hatalı:** `resmigazete-cestili-ilanlar`, `bddk-duyurular`
   (zaman aşımı), `saglik-bakanligi-personel` (liste yapısı tanınmadı). Kök neden + canlı HTML örneği
   gerekir. Komut: `npm run sources:report`.
2. **12 etkin kaynak hiç kayıt üretmiyor** — kapsam bu kaynaklar olmadan eksik.
3. **Worker/zamanlayıcı ve panel akışının gerçek koşumla doğrulanması** (AI telemetrisi yalnız 2 kayıt).

**P2 — kalite/gözlemlenebilirlik**

4. **KGM/TMSF/DSİ/İŞKUR eski gövdeleri:** seçici düzeltildi ama eski kayıtlar kendiliğinden
   düzelmiyor (`textExcerpt` birleştirmede güncellenmiyor). **Kullanıcı kararı bekliyor**; örnek
   metinler görülmeden uygulama yapılmayacak.
5. **4'lük kapı testinin ölçülmesi** (kota açıldığında; 429/503'te kod değiştirilmez).
6. **OKA ve YÖK tarihlerinin canlı kanıtla doğrulanması** (§5.2).

**P3 — bakım**

7. `tani:ilan`'daki "26 kayıt ESKİ" satırının yanıltıcı olması (metin düzeltmesi + test).
8. "5 Üniversite için Rektör Adaylığı" kaydının gerekçe etiketi yanlış ("öğrenci kabulü" yazıyor);
   kural istisnası gerekiyorsa bu bir kapsam genişletmedir → kullanıcı onayı şart.
9. İŞKUR kayıtlarının başlıkları hâlâ menü metni (kayıtlar reddedilmiş; etki düşük).

---

## 9) Sonraki AI için adım adım plan

1. **Durumu tazele:** `git pull --ff-only` → `npm ci` → `npm test` (beklenen: 102 dosya / 1276 test).
2. **Yedeği doğrula (kullanıcıda):** `dir data\backups` → `jobs-before-reclassify-*` dosyası var mı?
   Adını not et. Yoksa `--apply`'ın yedeği için acele etme; durumu kullanıcıya bildir.
3. **Kota durumu:** `npm run llm:doctor` → yeşilse
   `npm run eval:classification -- --file tests/fixtures/eval/ai-kapisi-senaryolari.json --llm`.
   Hedef: `uygun 4 · UYGUNSUZ 0 · kapı çalışmadı 0`. Hata 429/503 ise **kod değiştirme**, sonra
   tekrar dene; model değişikliği gerekiyorsa `LLM_CLASSIFIER_MODEL` + `LLM_MODEL` aynı aileden seçilir
   ve önce `llm:doctor` koşulur.
4. **OKA kanıtı:** `npm run tani:ilan -- --kaynak kariyerkapisi-isealim` → OKA kaydının
   "Yayım tarihi … (kaynak: listing|detail)" satırını oku; bulguyu buna göre kapat.
5. **Kaynak sağlığı:** `npm run sources:report` → 3 hatalı + 12 sıfır kaynağın detayı. Canlı HTML
   örneği olmadan seçici değiştirme; her değişiklik için test + `statusNote`/`verificationEvidence`
   alanlarını gerçek sonuçla güncelle (bkz. `src/config/sources.ts`).
6. **Kullanıcı kararı gelirse** KGM/TMSF gövde yenilemesi: örnek metin → küçük değişiklik →
   regresyon testi → `jobs:reclassify` benzeri güvenli akış (yedek + kuru çalıştırma).
7. **Raporları birlikte oku:** `docs/denetim-raporu-2026-10-16-uctan-uca.md` (§G.11–G.13) + bu belge.

---

## 10) Kullanıcının kararını bekleyen noktalar

1. **Gövde yenileme:** Kaynak yeniden tarandığında saklanan `textExcerpt` güncellensin mi?
   (Kullanıcı: "örnek metinleri görmeden uygulama kararı verme" dedi.)
2. **Rektör adaylığı ilanı** akışta kalmalı mı? (Evet denirse kural istisnası = kapsam genişletme.)
3. **`tani:ilan` "26 ESKİ" satırı** düzeltilsin mi? (P3, yalnız metin + test.)

---

## 11) Riskli komutlar ve sınırlar

**Üretim verisini değiştirir — yalnız kullanıcı onayı + önce yedek:**
`npm run jobs:reclassify -- --apply`, `npm run jobs:restore -- … --apply`, `npm run db:migrate`,
`npm run seed:*`, `npm run user:create`, her türlü toplu güncelleme/silme.

**Gerçek dış dünyaya temas eder — izinsiz çalıştırılmaz:**
gerçek kaynak taraması (canlı fetch), gerçek e-posta/Telegram gönderimi, sağlayıcıya ücretli LLM
çağrıları (yalnız kota+onay dahilinde, koşum başına ≤ 5 çağrı, retry 1).

**Gizlilik:**
`.env`, `POSTGRES_URL`/`DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LLM_API_KEY`, `RESEND_API_KEY`,
`SMTP_PASS`, `TELEGRAM_BOT_TOKEN`, `APP_SECRET`, `ADMIN_PASSWORD` **değerleri** hiçbir çıktıya, rapora,
commit'e veya sohbete yazılmaz. `.env` Git'e eklenmez. Kullanıcı aday profili dış servise gereksiz
gönderilmez; loglar maskeli hata metniyle tutulur (`recentFailures`).

**Git:**
Yalnız `arena/7ae2fdfa-kamuradar` dalına push edilir. `git push --force`, geçmiş yeniden yazımı ve
kullanıcı dosyalarının üzerine yazma yasaktır.

**Veri onarımı:**
Kayıt **silinmez**; bozuk tarih alanları `null` yazılır. Her toplu işlem öncesi tam yedek alınır.

---

## 12) Gerekli ortam değişkenleri (yalnız İSİMLER — değerler asla yazılmaz)

- **Veritabanı:** `DATABASE_DRIVER`, `POSTGRES_URL`, `DATABASE_URL`, `POSTGRES_SSL`,
  `POSTGRES_SSL_CA_FILE`, `POSTGRES_SSL_CA_MERGE_SYSTEM`, `POSTGRES_SSL_MODE`,
  `POSTGRES_MAX_CONNECTIONS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Uygulama:** `NODE_ENV`, `PORT`, `HOST`, `APP_DISPLAY_NAME`, `APP_BASE_URL`, `APP_DOMAIN`,
  `APP_SECRET`, `LOG_LEVEL`, `DATA_DIR`, `CORS_ORIGINS`, `SESSION_TTL_HOURS`, `RATE_LIMIT_*`,
  `ALLOW_PUBLIC_REGISTRATION`, `DOCS_ENABLED`
- **Toplama:** `SOURCE_LIVE_FETCH`, `SCRAPE_TIMEOUT_MS`, `SCRAPE_MAX_RETRIES`, `SCRAPE_USER_AGENT`,
  `SOURCE_MIN_REQUEST_INTERVAL_MS`, `SOURCE_BROWSER_FALLBACK`, `SOURCE_TLS_AIA_COMPLETION`,
  `SOURCE_ALLOWED_HOSTS`, `MAX_DOCUMENT_BYTES`, `MAX_REDIRECTS`, `DOCUMENT_TIMEOUT_MS`
- **LLM:** `AI_ASSISTANT_ENABLED`, `AI_PROVIDER_LABEL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
  `LLM_TIMEOUT_MS`, `LLM_CLASSIFIER_ENABLED`, `LLM_CLASSIFIER_MODEL`, `LLM_MAX_INPUT_CHARS`,
  `LLM_MAX_CALLS_PER_RUN`, `LLM_DAILY_CALL_LIMIT`, `LLM_MAX_CONCURRENCY`, `LLM_RETRY_MAX`,
  `LLM_COST_USD_PER_MTOK_INPUT`, `LLM_COST_USD_PER_MTOK_OUTPUT`, `AI_DAILY_LIMIT_PER_USER`
- **Bildirim:** `EMAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_API_BASE_URL`, `SMTP_*`, `EMAIL_FROM`,
  `EMAIL_DEV_FILE_TRANSPORT`, `EMAIL_MAX_ATTEMPTS`, `EMAIL_RETRY_BASE_MS`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`
- **Worker/zamanlayıcı:** `SCHEDULER_ENABLED`, `SCHEDULER_TICK_MS`, `WORKER_NAMESPACE`,
  `WORKER_CONCURRENCY`, `SCAN_INTERVAL_MINUTES`, `REDIS_URL`

Tam liste ve açıklamalar: `.env.example` (değer içermez).

---

## Ek: Bu belgenin doğrulama komutları (kopyala-çalıştır)

```
git -C C:\Users\Halil\Desktop\kamuradar-main status --short
git -C C:\Users\Halil\Desktop\kamuradar-main log --oneline -5
dir C:\Users\Halil\Desktop\kamuradar-main\data\backups
npm run tani:ilan
npm run sources:report
```
