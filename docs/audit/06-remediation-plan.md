# 06 — İyileştirme Planı (P0 → P3)

Her madde: **kanıt · etki · kök neden · düzeltme · düzeltmenin riski · test · kapanış ölçütü**.
Risk kimlikleri 03 numaralı belgeyle aynıdır.

**Durum işaretleri:** `YAPILDI` = kod değişti ve testi var · `KARAR` = ürün/politika kararı
gerekiyor, tek taraflı yapılmadı · `AÇIK` = planlandı, başlanmadı · `ENGELLİ` = ortam/izin yok.

## 0. Bu dalda yapılanlar (özet)

| ID | P | Durum | Ne değişti | Test |
| --- | --- | --- | --- | --- |
| R-05 | P0 | **YAPILDI** | `selectWithdrawalTarget()`: kanıtsız hedef yok; iptal, ilgisiz ilanı kapatamaz | `tests/ilan-iptal-guvenligi.test.ts` (6), `tests/list-drain.test.ts` |
| R-06 | P0 | **YAPILDI** | `/api/auth/unsubscribe` CSRF muafiyeti kaldırıldı | `tests/guvenlik-cikis-csrf.test.ts` (3) |
| R-07 | P1 | **YAPILDI (kısmi)** | `detectNewsReport()` haber/duyuru kapısı | `tests/classification-haber-dili.test.ts` (6) |
| — | P1 | **YAPILDI** | `hasApplicationUrl` üç durumlu ayrıştırma (`true/false/verilmedi`) | `tests/api-filtre-sozlesmesi.test.ts` (3) |
| — | P1 | **YAPILDI** | `$exists` iki yönlü düzeltme (dosya/Mongo/Postgres ortak) | `tests/sorgu-motoru-exists.test.ts` (4) |
| R-09 | P2 | **YAPILDI** | Vekilde istemci IP sahteciliği kapatıldı | `tests/vekil-istemci-ip.test.ts` (5) |
| R-07 | P1 | **YAPILDI** | 20 gerçek ilan/gozlem + 10 gerçek İçişleri duyurusu regresyonu | `tests/gercek-ilan-regresyon.test.ts` (5), `tests/gercek-kaynak-icisleri-regresyon.test.ts` (4) |

Toplam: **+33 test** (1376 → 1409).

## 1. P0 — üretim verisi / güvenlik

### P0-1 · İptal duyurusunun ilgisiz ilanı kapatması — YAPILDI
- **Kanıt:** [2] düzeltme öncesi `candidates[0]` davranışı testle üretildi; gerçek kayıt türü:
  `İptal İlanı (İzmir Kalkınma Ajansı)` [1].
- **Etki:** Yanlış ilan "iptal edildi" olarak kapanır → kullanıcı **var olan bir ilanı kaçırır**;
  düzeltmesi zor (sürüm geçmişi var ama kimse bakmaz).
- **Kök neden:** Kanıt yerine liste sırası; iptal duyurusu ile ilan arasında kimlik bağı yok.
- **Düzeltme:** Resmî no → kanonik URL → başlık kapsama → kurum + yüksek benzerlik sırasıyla
  hedef seçimi; kanıt yoksa `review`.
- **Düzeltmenin riski:** Bazı gerçek iptaller artık otomatik kapanmaz (inceleme kuyruğuna
  düşer). Bilinçli tercih: **yanlış kapatma yerine fazla inceleme**.
- **Test:** `tests/ilan-iptal-guvenligi.test.ts` 6/6; `tests/list-drain.test.ts` 7/7.
- **Kapanış:** Yukarıdaki testler + 30 günlük gerçek trafikte yanlış kapatma şikâyeti yok.

### P0-2 · `unsubscribe` üzerinden zorla çıkış — YAPILDI
- Ayrıntı: 03/R-06. **Test:** `tests/guvenlik-cikis-csrf.test.ts` 3/3.
- **Kapanış:** Üretimde e-posta bağlantısıyla abonelik kapatma akışı elle doğrulanır.

## 2. P1 — doğruluk ve erişim

### P1-1 · Haber/duyuru metinlerinin ilan sayılması — YAPILDI (kısmi)
- **Kanıt:** [2] düzeltme öncesi 9/9 haber başlığı `accept`; [1] Ekim 2026 gerçek haber dili
  ("Cumhurbaşkanı Erdoğan duyurdu: 38 bin personel alımı yapacak") — resmî sitelerde de aynı kalıp.
- **Düzeltme:** Başlıkta haber/aktarım dili + gövdede somut başvuru kanıtı yok → `reject`.
  Kanıt varsa `review` (sessizce yok edilmez). Resmî edilgen ilan kalıbı ("Duyurulur") korunur.
- **Kalan iş:** Gerçek altın küme üzerinde ölçüm (P1-3). Yeni kalıplar görüldükçe kural eklenecek.
- **Test:** `tests/classification-haber-dili.test.ts` 6/6.

### P1-2 · Herkese açık erişim yok — KARAR GEREKİYOR
- **Kanıt:** [1] `src/App.tsx` oturum yoksa `LoginPage` döndürüyor; `public/` içinde sitemap yok;
  kayıt kapalı (`ALLOW_PUBLIC_REGISTRATION=0`).
- **Etki:** Halka açık bir ilan servisi olarak **kullanılamaz**. KadroNerede karşılaştırmasında
  en büyük fark (05 numaralı belge, satır 1).
- **Neden yapılmadı:** Erişim modeli ve KVKK metinleri ürün/politika kararı. Kullanıcı talimatı:
  geri dönüşü zor veya politika değiştiren işler için onay.
- **Önerilen minimum değişiklik (onay sonrası ~1–2 gün):**
  1. `App.tsx`'te rota sınıflandırması: `public` (`/`, `/ilanlar`, `/ilan/:id`, `/kaynaklar`,
     `/gizlilik`, `/kvkk`, `/sss`) ve `gated` (panel, kaydedilenler, yönetim).
  2. Liste/detay bileşenlerinde kullanıcıya bağlı alanları (kaydet, öneri) gizle.
  3. `document.title` + `<meta name="description">` + `og:` etiketleri (R-16).
  4. `sitemap.xml` üreteci (yalnızca `active`/`upcoming` + kapanmış ilanların kalıcı sayfaları).
  5. KVKK/gizlilik metinlerinde "ziyaretçi" tanımı.
- **Test:** `tests/app-gate.test.tsx` yeni senaryolar; oturumsuz `/ilanlar` 200 + kart sayısı > 0,
  `/panel` → giriş.
- **Kapanış:** Oturumsuz kullanıcı gerçek 3 ilanı görebiliyor; giriş yalnızca kişisel işlevlerde.

### P1-3 · Gerçek, insan etiketli altın küme — AÇIK (insan emeği)
- **Kanıt:** [1] sınıflandırma eval seti 17 **sentetik** kayıt; `verify:all` "Gerçek-insan
  etiketi: 0" yazıyor.
- **Plan:** 150 kayıt (ilan.gov.tr 60, Resmî Gazete 30, 4 bakanlık duyurusu 40, süreç/ihale
  negatifleri 20). Her kayıt: başlık + gövde özeti + `beklenen` (accept-job / process / reject)
  + `labelProvenance: human` + etiketleyen + tarih.
- **Ölçüm:** kesinlik (yanlış kabul), duyarlılık (kaçırılan ilan), süreç/ilan karışıklığı.
- **Neden şimdi yapılmadı:** Etiketleme **insan** kararı gerektirir; ajan etiketi ölçüm sayılmaz
  (kullanıcı talimatı). Bu denetimde toplanan 30 gerçek kayıt `humanVerified:false` olarak duruyor.
- **Kapanış:** `eval:classification` gerçek metrik yayımlıyor; kesinlik ≥ 0,95.

### P1-4 · RLS / DB yetki ayrımı — AÇIK (onay + DB erişimi)
- Ayrıntı: 03/R-02. Uygulama dışı bir savunma katmanı yok. Üretim DB'sine dokunmadan
  yapılamaz → **izin gerekiyor**.

## 3. P2 — ölçek ve operasyon

| ID | İş | Durum | Not |
| --- | --- | --- | --- |
| R-03 | Postgres sorgularında SQL düzeyi filtre/sıralama/sayfalama; 20.000 satır sınırının kaldırılması | AÇIK | Bugün doğru davranıyor (sessiz kırpma yok, açık hata). 10 binden sonra zorunlu. |
| R-08 | Üretim sağlık/worker uçlarının doğrulanması | ENGELLİ | Ağ erişimi yok; dağıtım sahibi tarafından yapılmalı. |
| R-10 | Chromium ile E2E | ENGELLİ | Tarayıcı ikilisi yok; CI'da kurulabilir. |
| R-13 | PDF/OCR kapsamı | AÇIK | Önce "metin katmanı yok" ölçümü + kapsam raporu. |
| R-15 | CI'da haftalık `npm audit` | AÇIK | Bugün 0 açık; otomatikleştirilmedi. |

## 4. P3 — temizlik

| ID | İş | Durum |
| --- | --- | --- |
| R-11 | Hız sınırı sayacını DB yerine bellek/Redis'e taşıma | AÇIK |
| R-14 | README kaynak sayısı 27 → 28 | AÇIK (tek satır) |
| R-16 | Metaveri/SEO | P1-2'ye bağlı |
| R-17 | Arşiv sekmesi | P1-2 / R-12 kararına bağlı |

## 5. Sıralama önerisi

1. **Onay gerekenler (tek pakette):** P1-2 (herkese açık erişim), P1-4 (DB rolü/RLS).
2. **İnsan emeği:** P1-3 (150 etiket).
3. **Bağımsız, ajan tarafından yapılabilir:** R-03 (SQL'e taşıma), R-11, R-14, R-16, R-17.
4. **CI/ortam:** R-10, R-15, R-08.
