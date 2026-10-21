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

### R-03 · Postgres deposunda sorgu başına 20.000 satır tarama sınırı — **KISMEN AZALTILDI**
- **Kanıt:** [1] `src/db/postgres-store.ts` — `MAX_SCAN_ROWS = 20_000`, aşılırsa **hata**
  (sessiz kırpma yok — doğru davranış), sıralama/sayfalama bellekte.
- **Kök neden (bağımsız doğrulamada bulundu):** SQL ön filtresi tek bir çevrilemeyen
  koşulda (aralık, `$exists`, `$regex`, **noktalı yol**) tamamen düşüyordu. İlan listesi her
  sorguda `classification.decision = accept` (noktalı yol) eklediği için **her liste/arama
  sorgusu tüm `jobs` tablosunu** okuyordu; reddedilen kayıtlar da sınıra sayılıyordu.
- **Düzeltme (`fix/r03-postgres-onfiltre`):** çevrilemeyen bağlaç atlanır (üst küme korunur),
  noktalı yol eşitliği lax JSONPath (`jsonb_path_exists`) ile SQL'de uygulanır. [2]
  `tests/postgres-store.test.ts`: 20.050 satırlık PGlite tablosunda `repos.jobs.search`
  (eski kodda "20000 satırı aştı" hatası, yenide doğru 2 kayıt) + 250 rastgele bileşik
  sorguda Postgres = dosya sürücüsü (7 tohumla yerelde 1.750 sorgu).
- **Kalan:** sıralama/sayfalama hâlâ bellekte; sınır artık *eşleşen* satırlara uygulanır
  (kabul edilmiş + filtreye uyan > 20.000 olursa yine açık hata). `jsonb_path_exists` GIN
  indeksini kullanmaz (SQL içinde sıralı tarama). Gerçek Supabase/Postgres'te ve yük altında
  **ölçülmedi** [4] — yalnızca PGlite (Postgres 16 WASM).
- **Etki:** İlan sayısı ~20 bine yaklaşınca filtresiz liste/arama 500 verir; her istek
  O(n) bellek kullanır.
- **Öneri:** Filtre → SQL `WHERE data @> ...` / ifade indeksleri; sıralama ve `LIMIT/OFFSET`
  SQL'de; `count` ayrı sorgu.
- **Doğrulama:** 50.000 kayıtlı veri ile `GET /api/jobs?page=1` < 200 ms ve doğru sayfa.
- **Kapanış ölçütü:** Yük testi + sayfalama doğruluğu.

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

### R-17 · Arşiv/iptal görünümü yok
- **Kanıt:** [1] `Filters.tsx` durum filtresi var, ayrı sekme yok; kapalı ilanlar varsayılan
  listede `newest` sıralamasıyla üste çıkabilir.
- **Öneri:** `?sekme=arsiv` eşdeğeri + varsayılan `active,upcoming`.
- **Bağımlılık:** R-12 ile aynı ürün kararı.

---

## Kapsam dışı bırakılanlar [5]

- KadroNerede'nin iç algoritması, veri kaynakları, güncelleme sıklığı (bilinmiyor, tahmin edilmedi).
- Üçüncü taraf sitelerde yetkisiz test/otomatik tarama (yapılmadı, yapılmayacak).
- Üretim veritabanına yazma, şema değişikliği, dağıtım (onay gerektirir; yapılmadı).
