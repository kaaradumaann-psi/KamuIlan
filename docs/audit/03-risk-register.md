# 03 — Risk Kaydı

**Tarih:** 21.10.2026 · **Kapsam:** Kamuİlan deposu (`4fd9acb` + bu dalın düzeltmeleri)
**Kanıt düzeyleri:** [1] doğrudan kanıt (kod/çalıştırma) · [2] tekrarlanabilir test ·
[3] güçlü olasılık · [4] henüz doğrulanamadı · [5] kapsam dışı

> Kural: **hiçbir risk "kapandı" sayılmaz**, yalnızca "azaltıldı" veya "kabul edildi".
> Kapatma ölçütü her satırda yazılıdır.

## Öncelik özeti

| Öncelik | Sayı | Başlıklar |
| --- | --- | --- |
| **P0** (üretim verisi bozulması / güvenlik) | 0 açık, 2 azaltıldı | R-05 (yanlış iptal), R-06 (CSRF zorla çıkış) |
| **P1** (ürün/veri doğruluğu) | 5 | R-01 erişim modeli, R-02 DB yetki, R-04 gerçek altın küme, R-07 haber/duyuru, R-12 süreç duyuruları |
| **P2** (ölçek/operasyon) | 5 açık, 1 kısmen kapandı | R-03 tarama sınırı, R-08 üretim durumu, R-09 proxy güveni, R-13 PDF/OCR, R-15 bağımlılık (R-10 CI'da geçiyor, yerelde engelli) |
| **P3** (temizlik/iyileştirme) | 3 açık | R-11 hız sınırı deposu, R-16 metaveri/SEO, R-17 arşiv görünümü (R-14 README düzeltildi) |

---

## P0 — üretim verisi veya güvenlik (bu denetimde azaltıldı)

### R-05 · İlgisiz ilanın "iptal edildi" diye kapatılması — **AZALTILDI**
- **Kanıt:** [2] `tests/ilan-iptal-guvenligi.test.ts` (6 test), `tests/list-drain.test.ts`
- **Ne oluyordu:** İptal/geri çekme duyurusu geldiğinde hedef ilan, aday listesinin **ilk**
  elemanı (`candidates[0]`) seçiliyordu. Aday listesi son 400 ilanla dolu olduğu için
  kurum bilgisi eşleşmediğinde **en son eklenen ilgisiz ilan** "iptal" olarak kapatılıyordu.
- **Kök neden:** Kanıt yerine sıralama varsayımı; ayrıca iptal duyurusu ile ilan başlığı
  arasında bağ (referans/URL/kapsama) aranmıyordu.
- **Düzeltme:** `selectWithdrawalTarget()` — yalnızca (1) resmî ilan no, (2) kanonik URL,
  (3) başlık kapsama, (4) kurum + yüksek benzerlik. Kanıt yoksa **ilan kapatılmaz**,
  inceleme kuyruğuna düşer.
- **Kalan risk:** Yeni kaynaklarda farklı kimlik biçimleri (ör. yalnızca PDF içinde numara)
  kanıt üretmeyebilir → inceleme kuyruğu büyür, veri bozulmaz.
- **Kapanış ölçütü:** 30 gün boyunca inceleme kuyruğunda "yanlış kapatma" şikâyeti yok +
  gerçek iptal örnekleri (Resmî Gazete + ilan.gov.tr) regresyon testinde.

### R-06 · `/api/auth/unsubscribe` CSRF muafiyeti ile zorla çıkış — **AZALTILDI**
- **Kanıt:** [1] `src/server/app.ts` (muafiyet kaldırıldı), [2] `tests/guvenlik-cikis-csrf.test.ts`
- **Ne oluyordu:** Uç, jetonlu (oturumsuz) akış için CSRF'ten muaf tutulmuştu; ama aynı uç
  oturumla da çalışıyor ve `{ all: true }` ile **tüm oturumları** kapatıyordu. Bir saldırgan
  kullanıcıyı üçüncü taraf sayfadan bu uca göndererek tüm oturumlarını düşürebilirdi.
- **Düzeltme:** Muafiyet kaldırıldı. Oturumsuz isteklerde CSRF zaten uygulanmıyor, yani
  e-postadaki bağlantı akışı bozulmadı.
- **Kapanış ölçütü:** Test yeşil + üretimde e-posta aboneliği kapatma akışı elle doğrulandı.

---

## P1

### R-01 · Uygulama tamamen giriş kapılı; halka açık sayfa yok
- **Kanıt:** [1] `src/App.tsx` (`if (!user) return <LoginPage/>`), `tests/app-gate.test.tsx`;
  [1] `public/` içinde yalnızca `robots.txt`, `_headers`, `favicon.svg`.
- **Etki:** Kayıt olmayan hiç kimse tek bir ilanı göremez. Kayıt **davetle** ve varsayılan
  kapalı (`ALLOW_PUBLIC_REGISTRATION=0`). Bu, "resmî ilanları herkese ulaştırma" hedefinin
  **tamamını** engelliyor; SEO/indeksleme ve paylaşılabilir bağlantı da yok.
- **Olasılık:** Kesin (yapısal).
- **Kök neden:** Ürün kararı: iç/davetli kullanım için tasarlanmış; herkese açık vitrin
  hiç eklenmemiş.
- **Öneri (karar gerekiyor):** İlan listesi ve detayı **salt okunur herkese açık**;
  kaydet/bildirim/profil için giriş. Teknik olarak rota kapısını `publicRoutes` listesine
  bölmek + `GET /api/jobs` zaten public olduğu için ek uç gerekmez.
- **Doğrulama testi:** `tests/app-gate.test.tsx` yeni senaryo: oturumsuz `/ilanlar` liste
  gösterir, `/panel` girişe yönlendirir; `GET /api/jobs` 200.
- **Kapanış ölçütü:** Oturumsuz kullanıcı 3 gerçek ilanı görebiliyor + gizlilik/KVKK
  metinleri buna göre güncellendi.
- **Neden şimdi yapılmadı:** Erişim modeli değişikliği ürün/politika kararı; izinsiz
  yapılmadı (kullanıcı talimatı: geri dönüşü zor/ürün kararı olan değişiklikler onay ister).
- **Bulgu (21.10.2026, bağımsız doğrulama):** [1] API ilan uçları (`GET /api/jobs`,
  `/api/jobs/stats`, `/api/jobs/:id`, `/api/jobs/:id/sources`) **zaten oturumsuz** yanıt
  veriyor (yalnızca onaylı ilanlar, `toPublic*` serileştiricileri). "Kapalı sistem" kapısı
  yalnızca arayüzde; onaylı ilan verisi bugün de herkese açık.
- **Uygulandı (bayrak arkasında, `feat/herkese-acik-ilanlar`):** `PUBLIC_LISTINGS_ENABLED`
  (varsayılan **0**). Açıkken oturumsuz ziyaretçi ana sayfa, ilan listesi/detayı ve kaynakları
  görür; panel, kayıtlı ilanlar, geçmiş ve yönetim kendi `RequiresSession` kapısıyla korunur.
  Kayıt politikası (`ALLOW_PUBLIC_REGISTRATION`) değişmez. [2]
  `tests/herkese-acik-vitrin.test.tsx` (6), `tests/herkese-acik-vitrin-api.test.ts` (4).
- **Açmadan önce gereken karar:** Gizlilik/KVKK ve SSS metinleri "kapalı sistem" dilini
  içeriyor; vitrin açılırsa güncellenmeli. Üretimde bayrak açılmadı.

### R-02 · Veritabanında RLS yok; tek kimlikle tam yetki
- **Kanıt:** [1] `src/db/postgres-store.ts` (tek `pg.Pool`, tablo bazlı erişim, RLS politikası yok);
  [1] tüm yetkilendirme uygulama katmanında (`requireUser`/`requireAdmin`).
- **Etki:** Uygulamadaki tek bir yetki hatası (eksik `requireAdmin`, yanlış filtre) **tüm**
  kullanıcı/oturum/denetim verisine erişim demektir. Yatay savunma yok.
- **Olasılık:** Orta (mevcut kodda eksik yetki bulunmadı; 56 rotanın tamamı gözden geçirildi).
- **Kök neden:** Mimari: Supabase *istemci* kitaplığı kullanılmıyor, doğrudan Postgres.
- **Öneri:** (a) uygulama için ayrı, yalnızca gerekli tablolara yetkili DB rolü;
  (b) kritik tablolarda (`users`, `sessions`, `tokens`, `auditLogs`) RLS + `SET LOCAL
  app.user_id`; (c) yedek/geri yükleme provası.
- **Doğrulama testi:** Yetkisiz rol ile `SELECT` denemesi reddedilmeli (entegrasyon testi,
  gerçek Postgres gerekir — şu an Docker/DB yok).
- **Kapanış ölçütü:** Prod DB'de RLS açık + uygulama tüm testleri geçiyor.

### R-04 · Gerçek, insan etiketli altın küme yok → kesinlik/duyarlılık bilinmiyor
- **Kanıt:** [1] `src/classification/eval-set.ts` — 17 kayıt, tamamı sentetik; koşucu
  "VERİ YETERSİZ" diyor. [1] `docs/eval-gercek-veri.md` aynı sınırı yazıyor.
- **Etki:** "Yanlış ilan yayımlama" riski ölçülemiyor; sadece tek tek vakalarla
  (bu denetimde 9 haber başlığı gibi) yakalanabiliyor.
- **Kök neden:** Etiketleme insan emeği ister; otomatik üretilen etiketler ölçüm sayılmaz.
- **Öneri:** 100–200 gerçek kaydı (ilan.gov.tr + Resmî Gazete + 2 bakanlık duyurusu)
  insan etiketiyle işaretle; `eval:classification` insan etiketi yoksa **metrik
  yayımlamasın** (şu an yayımlamıyor — doğru davranış).
- **Doğrulama testi:** `eval:classification` çıktısında `precision/recall` yalnızca
  `labelProvenance: human` iken görünür.
- **Kapanış ölçütü:** ≥100 insan etiketli kayıt, kesinlik ≥0.95, yanlış kabul ≤%2.
- **Durum (23.10.2026):** AÇIK. İnsan etiketli kayıt **0** (hedef 145). #50 ile
  `npm run eval:build-set` varsayılan çağrısı düzeltildi; yerel çalışma sayfasında 6 gerçek
  kayıt var (`data/`, git dışı, etiketsiz). Gerçek LLM sağlayıcı testi yapılmadı (anahtar yok);
  AI testlerinin tamamı sahte sağlayıcıyla (mock) çalışır.

### R-07 · Kurumsal haber/duyuru metinlerinin iş ilanı olarak yayımlanması — **AZALTILDI**
- **Kanıt:** [2] düzeltme öncesi tekrarlanan prob: 9/9 haber başlığı `accept`;
  [4] gerçek dünya örneği: Ekim 2026'da "Cumhurbaşkanı Erdoğan duyurdu: 38 bin personel
  alımı yapacak", "Bakan Memişoğlu'ndan personel alımı açıklaması" gibi başlıklar
  (kaynak: web araması, 21.10.2026). *Bağımsız doğrulama notu:* bu başlıkların URL'si ve
  ham kaydı depoda yok; düzey [1]'den [4]'e indirildi.
- **Düzeltme:** `detectNewsReport()` — haber/aktarım dili + somut başvuru kanıtı yok → `reject`;
  somut kanıt varsa `review`. Gerçek ilan kalıbı ("… Yapılacağı Duyurulur") etkilenmez.
- **Bağımsız doğrulamada bulunan yan etki (düzeltildi):** `haber.konusmaci-aktarimi`
  kalıbı ünvandan sonra herhangi bir sözcüğü kabul ediyordu; "Müdür Yardımcısı Alım İlanı",
  "Vali Yardımcısı Kadrosu Personel Alımı" gibi **gerçek ilan başlıkları `reject`** alıyordu
  (önce `accept`). Ayrıca "… Alım İlanı Hakkında Açıklama" başlığı `accept` → `reject`
  oluyordu. Düzeltme: ünvandan sonraki sözcük görev/alım sözcüğüyse kalıp eşleşmez; başlık
  kendini "ilan" diye adlandırıyorsa haber kapısı en fazla `review` verir.
  [2] `tests/classification-haber-dili.test.ts` (+3 test). Bkz. 07 §6.
- **Kalan risk:** Görülmemiş haber kalıpları (ör. "… alımına yeşil ışık") hâlâ geçebilir.
  Gövdesinde "bildirildi/duyurdu" geçen gerçek ilanlar `review`'a düşer (yayımlanmaz,
  kaybolmaz; inceleme yükü artar).
- **Kapanış ölçütü:** Gerçek altın küme (R-04) üzerinde yanlış kabul ≤%2.

### R-12 · Süreç duyuruları (sınav/sonuç/kura) varsayılan ilan akışında
- **Kanıt:** [1] `tests/kind-api.test.ts` **bilinçli olarak** varsayılan listede hem `job`
  hem `process` bekliyor; [1] gerçek İçişleri duyurularında 10 kayıttan 4'ü `process` kabul ediliyor.
- **Etki:** Kullanıcı "Sözleşmeli Bilişim Personeli Sözlü Sınav Sonuç Listesi"ni açık kadro
  sanabilir. Sayaçlar (`/api/jobs/stats`) süreç kayıtlarını **saymıyor**, yani tutarsızlık var:
  liste "1 sonuç" derken sayaç 0 diyor.
- **Neden otomatik değiştirilmedi:** Mevcut test bu davranışı **açıkça** doğruluyor →
  ürün kararı. Tek taraflı değiştirmek mevcut kararı bozmak olurdu.
- **Öneri:** Varsayılan `kind=job`; süreç duyuruları ayrı sekme. (KadroNerede arşivi ayrı
  sekmede tutuyor — aynı kullanıcı ihtiyacı, farklı mimari.)
- **Kapanış ölçütü:** Karar verildikten sonra test güncellenir; liste ve sayaç aynı kümeyi sayar.

---

## P2

### R-03 · Postgres deposunda sorgu başına 20.000 satır tarama sınırı — **BÜYÜK ÖLÇÜDE AZALTILDI (22.10.2026)**
- **Kanıt:** [1] `src/db/postgres-store.ts` — `MAX_SCAN_ROWS = 20_000`, aşılırsa **hata**
  (sessiz kırpma yok); eski hâlde sıralama/sayfalama/sayım bellekte.
- **Bağımsız doğrulamada bulunan ek kırılmalar** (`tests/r03-sql-tam-ceviri.test.ts`, eski kodda kırmızı):
  - İlan kabul hattı her kayıtta `find('jobs', {}, {limit: 400, sort: createdAt})` çağırıyor
    (`src/ingest/jobs-service.ts` `findCandidates`): `jobs` 20.000 satırı geçince **her ilan işlenemez,
    tarama durur** — liste ekranından önce bozulan yol buydu.
  - `scrapeRuns` hiç temizlenmiyor; `count('scrapeRuns', {})` tüm tabloyu okuyor (24 kaynak × saatlik
    ≈ 5 haftada 20.000 satır → özet/panel uçları hata).
  - `jobs:reclassify` / `jobs:restore` tüm tabloyu `find('jobs', {}, {limit: 100_000})` ile okuyor.
  - Sorgu dili `$ne`/`$nin` koşulunda eksik alanı eşlemiyordu (Mongo eşler): `classification.kind`
    alanı olmayan eski ilanlar `kind=job` listesinden ve ana sayfa sayılarından düşüyordu.
- **Düzeltme (`fix/r03-sql-siralama-sayfalama`):**
  - `src/db/postgres-exact.ts`: şeması sabit alanlarda (`EXACT_FIELDS`: jobs, jobSources,
    sourceItemDecisions, scrapeRuns) sorgu `matchesQuery` ile **eşdeğer** SQL'e çevrilir;
    filtre, `ORDER BY`, `LIMIT/OFFSET` ve `COUNT` SQL'de. Çevrilemeyen sorgu eski yola düşer.
  - Şemaya uymayan satırlar (`quota: "25"` gibi) SQL'de karara bağlanmaz; kısmi indeksli
    (`*_sapma_v1`) ayrı sorguyla çekilip bellekte değerlendirilir. Dönen satırlar yine
    `matchesQuery`'den geçer: çeviri hatası yanlış satır döndüremez.
  - Sıralama ifadeleri için metin indeksleri (`*_txt_*`, `NULLS LAST`) ve `deadline_asc`.
  - `src/db/query.ts`: `$ne`/`$nin` eksik alanı Mongo gibi eşler (`$ne: null` eşlemez).
- **Doğrulama [2]:** 20.050 satırda kabul hattı sorguları, liste sayfası ve özet sayıları doğru;
  400 belgede 240 rastgele ilan araması + 9 operatör sorgusu × 3 sıralama Postgres = dosya sürücüsü
  (toplam ve sayfa kimlikleri birebir); mevcut PGlite fark testleri (şemaya aykırı verili) yeşil.
- **Ölçüm** (`scripts/bench-postgres-list.ts`, **PGlite/WASM**, 50.000 satır, medyan):
  `GET /api/jobs?page=1` 3.480 → **158 ms**; `sort=deadline` **159 ms**; kabul hattı son 400 ilan
  1.086 → **15 ms**; filtreli liste (`kind+status+şehir`) **568 ms**; metin araması `q` **723 ms**.
- **Kalan:** gerçek Postgres/Supabase'te ölçüm **yapılmadı** [4] (staging yok; komut
  `BENCH_POSTGRES_URL` ile hazır). Filtreli sayım tam tarama; `q` araması için trigram (pg_trgm)
  indeksi ölçüm sonrası değerlendirilmeli. `EXACT_FIELDS` dışındaki koleksiyonlar eski yolda.
- **Kapanış ölçütü:** staging Postgres'te 50.000 kayıtla `GET /api/jobs?page=1` < 200 ms.
- **Durum (23.10.2026):** AÇIK. #37 birleşti; yukarıdaki tüm sayılar **PGlite/WASM** ölçümüdür,
  gerçek Postgres sonucu yerine geçmez. `pg_trgm` indeksi gerçek Postgres `EXPLAIN ANALYZE`
  ölçümü olmadan eklenmeyecek. `scrapeRuns` hâlâ temizlenmiyor (saklama işi açık).

### R-08 · Üretim ortamının gerçek durumu doğrulanamadı
- **Kanıt:** [4] Üretim sağlık ucu bu ortamdan erişilemedi; `https://api.kamuilan...`
  yanıtı doğrulanmadı. Yerel ölçüm: `degraded`, 24 kaynak bayat.
- **Etki:** "Üretimde çalışıyor" iddiası **kurulamaz**. Dağıtım/izleme durumu bilinmiyor.
- **Kapanış ölçütü:** Üretim `/api/health` + `/api/health/worker` yanıtı (sürüm + zaman)
  kayda geçirilir; 7 gün kesintisiz çalışma.

### R-09 · Vekil (Cloudflare Function) istemci IP'si
- **Kanıt:** [1] `functions/api/[[path]].ts` — istemciden gelen `x-forwarded-for`,
  `x-real-ip`, `forwarded` **atılıyor**; değer yalnızca `cf-connecting-ip`'den yazılıyor.
  [2] `tests/vekil-istemci-ip.test.ts` (5 test). [1] `docs/deployment.md` `TRUST_PROXY=1`.
- **Etki (önce):** İstemci sahte IP gönderip hız sınırını atlatabilir; tüm kullanıcılar tek
  kovaya düşebilirdi.
- **Kalan risk:** `TRUST_PROXY` yanlış yapılandırılırsa (API doğrudan internete açıkken 1)
  aynı sorun geri gelir → dağıtım denetim maddesi.
- **Azaltma (`fix/r09-vekil-guven-siniri`):** `TRUST_PROXY` artık güvenilen vekil listesi
  kabul ediyor (`cloudflare`, CIDR, `uniquelocal`…); `clientIp()` ham başlık yerine
  Fastify/proxy-addr kararını (`request.ip`) kullanıyor. [2] `tests/vekil-guven-siniri.test.ts`
  (7): vekili atlayan sahte başlık yeni kova açamıyor; Cloudflare arkasındaki farklı
  istemciler ayrı kovada; zincire sola eklenen sahte değer yok sayılıyor.
- **Kapanış ölçütü:** Üretimde `TRUST_PROXY=cloudflare` (veya gerçek vekil listesi) ayarlı
  ve kökene doğrudan istekte sahte `X-Forwarded-For` ile hız sınırının aşılamadığı doğrulandı
  — **üretim ayarı kullanıcı/işletim kararı; bu depoda değiştirilmedi.**

### R-10 · Tarayıcı E2E — **CI'da KAPANDI**, yerel ortamda engelli
- **Kanıt:** [1] GitHub Actions `verify` işi, run `39597847874` (commit `911b0b4`):
  `Playwright tarayıcıları` ve `Uçtan uca testler` adımları **success**. 4 spec / 20 test
  (`e2e/smoke.spec.ts` 9, `accessibility` 6, `sources` 3, `security` 2).
- **Yerel durum:** Bu denetim sandbox'ında Chromium yok → `npx playwright test` BLOCKED.
  Yani E2E **kodda ve CI'da var ve geçiyor**; yalnızca bu ortamda koşulamıyor.
- **Etki:** Giriş kapısı, filtreler, klavye/erişilebilirlik, güvenlik başlıkları gerçek
  tarayıcıda doğrulanmış durumda. Kalan boşluk: yerel geliştirici geri bildirimi.
- **Kapanış ölçütü:** Yerel `npm run test:e2e` (Chromium kurulduktan sonra) yeşil.

### R-13 · PDF ağırlıklı kaynaklar ve OCR yokluğu
- **Kanıt:** [1] Resmî Gazete 21.10.2026 "Çeşitli İlânlar" bölümünün bir kısmı yalnızca PDF;
  [1] `src/extraction/pdf.ts` metin katmanı okuyor, OCR yok.
- **Etki:** Metin katmanı olmayan PDF'lerde alan çıkarımı boş kalır → kayıt `review`'a düşer
  (yayımlanmaz, doğru davranış) ama kapsam kaybı olur.
- **Kapanış ölçütü:** OCR veya "PDF metni yok" göstergesi + kapsam raporunda ölçüm.
- **Durum (23.10.2026): KOD TAMAM, VARSAYILAN KAPALI.** #49: `src/extraction/ocr.ts`
  (tesseract.js, Türkçe), `OCR_ENABLED=0` varsayılan; açıkken güveni eşiğin altındaki OCR metni
  kullanılmaz (`src/extraction/pdf.ts`) — kayıt metinsiz PDF yolundan geçer. Dil verisi: `OCR_LANG_PATH` boşsa tesseract.js kendi dağıtım adresinden
  ilk çalıştırmada indirir ve `DATA_DIR/ocr-cache`'e yazar — ağsız sunucuda `OCR_LANG_PATH`
  verilmelidir. Gerçek doğrulama yalnız yerel 2 RG belgesi (güven 90 ve 91). Üretimde açılması
  dağıtım kararıdır. Açık: tablo bölgesinde gürültü, satır/kelime güveniyle ayıklama yok.
- **Ayrıca (#47):** PDF metni konuma göre birleşiyor; harf kopukluğu yerel 16 PDF'te 569 → 0.

### K3 notu · Mevcut kayıtları yeniden işleme (23.10.2026)
- #39 (eski sürümlü ret kararlarının yeniden değerlendirilmesi) **yeni tarama yolunda** çalışır;
  `jobs:reclassify` ret kayıtlarına ulaşmaz. Üretimde yeniden sınıflandırma **çalıştırılmadı**
  (üretim DB yazımı, depo sahibi onayı gerekir).

### R-15 · Bağımlılık ve lisans durumu
- **Kanıt:** [1] `npm audit` (21.10.2026): üretim 160, geliştirme 242 bağımlılık — **0 bilinen açık**.
  Lisanslar: MIT (19), Apache-2.0 (2), BSD-2-Clause (1), MIT-0 (1) — **copyleft yok**.
- **Kalan risk:** Gelecekteki sürümler; otomatik `npm audit` CI adımı yok (görülmedi).
- **Kapanış ölçütü:** CI'da haftalık `npm audit` + Dependabot/benzeri.

---

## P3

### R-11 · Hız sınırı sayacı veritabanında
- **Kanıt:** [1] `src/server/app.ts` → `enforceRateLimit(repos.rateLimits, ...)`; her istek
  okuma+yazma. Temizlik görevi var (`purgeOlderThan`).
- **Etki:** Yük altında ek DB trafiği; çok örnekli dağıtımda yarış koşulları (atomik
  artırım var mı doğrulanmalı [4]).
- **Öneri:** Redis/bellek içi kova ya da atomik `UPDATE ... RETURNING`.

### R-14 · README kaynak sayısı bayat — **DÜZELTİLDİ**
- **Kanıt:** [1] README "27 kayıtlı kaynak" diyordu; `src/config/sources.ts` **28** (24 etkin).
- **Etki:** Düşük; ama "kaç kaynak var" sorusuna yanlış cevap verilmesine yol açıyordu.
- **Düzeltme:** README 28'e güncellendi (+ "24 etkin, 4 kapalı" açıklaması ve denetim belgeleri bağlantısı).

### R-16 · Metaveri/SEO yok
- **Kanıt:** [1] `public/` sitemap yok; `index.html` tek `<title>`; istemci tarafında
  `document.title` güncellemesi **görülmedi**.
- **Etki:** Paylaşılan bağlantılar başlıksız görünür; arama motoru indekslemesi yok.
- **Not:** R-01 çözülmeden SEO'nun anlamı yok → R-01'e bağımlı.
- **Uygulandı (`feat/seo-metaveri`, PR #30'a bağlı):** sayfa başlığı/açıklaması ve `og:` etiketleri
  istemci tarafında; ilan detayında yalnızca mevcut alanlardan `JobPosting` JSON-LD (`</script>`
  kaçışlı); `GET /api/sitemap.xml` yalnızca `PUBLIC_LISTINGS_ENABLED=1` iken ve yalnızca onaylı
  ilanlarla. [2] `tests/seo-metaveri.test.ts` (5), `tests/seo-ui.test.tsx` (1).
- **Kalan:** `public/robots.txt`'e `Sitemap:` satırı eklenmedi (statik dosya bayrağa göre
  değişemez; vitrin açılınca eklenmeli). Sitemap `/api/` altında; Cloudflare vekili bu yolu
  API'ye taşır. SPA olduğu için sunucu tarafı ön-render yok.

### R-17 · Arşiv/iptal görünümü yok
- **Kanıt:** [1] `Filters.tsx` durum filtresi var, ayrı sekme yok; kapalı ilanlar varsayılan
  listede `newest` sıralamasıyla üste çıkabilir.
- **Öneri:** `?sekme=arsiv` eşdeğeri + varsayılan `active,upcoming`.
- **Bağımlılık:** R-12 ile aynı ürün kararı.

---

### R-18 · Varsayılan tarayıcı kimliği Resmî Gazete'de engelleniyor — **YENİ (21.10.2026)**
- **Kanıt:** [1] Gerçek staging koşumu (07 §8): varsayılan `SCRAPE_USER_AGENT`
  (`Mozilla/5.0 (compatible; KamuIlanBot/0.2; +https://…)`) ile Resmî Gazete yanıt başlığı
  göndermiyor (zaman aşımı); `Bot` sözcüğü çıkarılınca anında 200.
- **Etki:** Üretim aynı varsayılanı kullanıyorsa Resmî Gazete taraması **her koşumda** zaman
  aşımına düşüyor olabilir; kaynak sağlığı "başarısız" görünür, ilan gelmez. Üretim ayarı
  doğrulanamadı [4].
- **Öneri (karar gerekiyor):** Varsayılanı kimliği ve iletişim adresini koruyarak
  `Mozilla/5.0 (compatible; KamuIlan/0.2; +https://kamuilan.halilkaraduman.com.tr)` yapmak.
  Bu, kaynağın filtresine karşı bir kimlik tercihidir; kod varsayılanı değiştirilmedi.
- **Kapanış ölçütü:** Üretim kaynak sağlığında Resmî Gazete son koşumu `complete`/`partial`.

### R-19 · "Bursa" kurumlarının ilanları "burs" sayılıp reddediliyordu — **DÜZELTİLDİ (21.10.2026)**
- **Kanıt:** [2] `ret-baslik.staj-burs` kalıbı `\bburs\w*` idi; "Bursa Valiliği / Belediyesi /
  Uludağ Üniversitesi …" başlıkları başlık düzeyinde %92 güvenle `reject` alıyordu. 81 il × 4
  kurum biçimi taramasında kabul dışı kalan 4 başlığın 4'ü de Bursa'ydı.
- **Etki:** Türkiye'nin 4. büyük ilindeki kurumların gerçek ilanları sessizce akıştan düşüyordu
  (yanlış ret; inceleme kuyruğuna da gitmez).
- **Düzeltme (`fix/bursa-burs-yanlis-ret`):** `burs(?!a)\w*`. Test: `tests/classification.test.ts`
  81 il taraması + burs duyurularının hâlâ reddedildiği 3 örnek.
- **Kalan:** Mevcut kayıtlarda Bursa ilanları reddedilmiş olabilir → düzeltme ancak
  `jobs:reclassify` ile uygulanır (üretim DB — karar gerekiyor). Apostrofsuz yazılmış "burs'a"
  ("bursa başvuru") artık bu kurala takılmaz; diğer kurallar/inceleme devreye girer.

## Kapsam dışı bırakılanlar [5]

- KadroNerede'nin iç algoritması, veri kaynakları, güncelleme sıklığı (bilinmiyor, tahmin edilmedi).
- Üçüncü taraf sitelerde yetkisiz test/otomatik tarama (yapılmadı, yapılmayacak).
- Üretim veritabanına yazma, şema değişikliği, dağıtım (onay gerektirir; yapılmadı).
