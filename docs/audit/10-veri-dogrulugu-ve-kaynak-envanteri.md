# 10 — Veri Doğruluğu ve Kaynak Envanteri (Phase 4)

**Amaç:** "İş ilanı yayımlıyoruz" iddiasını kanıta bağlamak. Yanlış ilan, yanlış tarih,
kurumsal haber ve yanlış kapanmış ilan **yayımlanmamalı**.
**Kanıt:** `src/config/sources.ts` (28 tanım), `src/classification/*`, `src/extraction/*`,
`src/ingest/*`; ölçümler 21.10.2026.

## 1. Kaynak envanteri — gerçek dağılım

`verify:all` çıktısı: **28 kaynak · 24 etkin · 15 doğrulanmış · 9 "scraper-built" · 4 "needs-manual-method"**.

Kaynak **güven katmanı** (bizim sınıflandırmamız; resmî statü iddiası değil):

### A. Birincil resmî ilan platformları (ilanın kendisi burada yayımlanır)

| Kaynak | Durum | Güven |
| --- | --- | --- |
| `ilan-gov-tr-personel` — ilan.gov.tr personel alımı listesi | scraper-built | **A** — BİK'in resmî ilan portalı; ilanın aslı |
| `ilan-gov-tr-api-personel` — aynı havuzun JSON API'si | scraper-built | **A** |
| `kariyerkapisi-isealim` — Kariyer Kapısı | doğrulanmış (12.10) | **A** — Cumhurbaşkanlığı İK platformu |
| `iskur-kamu-memur-alim` / `iskur-kurumdisi-kamu-isci` | doğrulanmış (13.10) | **A** — İŞKUR resmî ilanları |
| `kamuilan-sbb` — Strateji ve Bütçe Başkanlığı Kamu İlan | doğrulanmış (13.10) | **A/B** — merkezî kamu ilan havuzu |

### B. Resmî gazete / kurumsal duyuru (ilan burada "duyuru" olarak çıkar)

| Kaynak | Durum | Not |
| --- | --- | --- |
| `resmigazete-cestili-ilanlar` | **doğrulanmış** (12.10) | "Çeşitli İlânlar" bölümü; **bir kısmı yalnızca PDF** (21.10.2026 gözlemi) |
| `osym-duyurular` | doğrulanmış (12.10) | Sınav/tercih duyurusu ağırlıklı → çoğu **process** veya **reject** |
| `meb-personel-duyurular` | doğrulanmış (12.10) | RSS; atama/sınav duyuruları karışık |

### C. Bakanlık/kurum "duyurular" sayfaları (gürültü oranı yüksek)

`adalet`, `icisleri`, `goc-idaresi`, `afad`, `sgk`, `dsi`, `kgm`, `tkgm`, `tubitak`, `yok`,
`bddk`, `spk`, `epdk`, `tmsf`, `saglik-bakanligi` — toplam **15 kaynak**.
Bunlar **iş ilanı panosu değildir**; sınav, sonuç, kararname, tören, fiyat listesi yayımlarlar.
Gerçek ölçüm (İçişleri, 21.10.2026): 10 duyurunun **hiçbiri** iş ilanı değil; 4'ü `process`,
6'sı ilan dışı.

### D. Kapalı / elle yöntem gerektiren (4)

`iskur-esube-acik-is` (JS/oturum), `gib-duyurular`, `tuik-duyurular`, `rtuk-duyurular`
→ `needs-manual-method`, `enabled: false`. **Kapalı olmaları doğru**: yöntem doğrulanmadan
açmak, sessizce boş tarama demektir.

> **Kural:** C ve D katmanından gelen bir kayıt, tek başına "ilan" sayılmaz. A katmanındaki
> bir kaynakla eşleşmiyorsa `review` eşiği daha yüksek tutulmalıdır (öneri, 06/P1-3 ile birlikte).

## 2. Sınıflandırma ayrımları (ne ilan sayılır, ne sayılmaz)

| Sınıf | Karar | Kanıt kuralı | Örnek |
| --- | --- | --- | --- |
| **Gerçek alım ilanı** | `accept` + `kind: job` | Başlıkta alım/unvan kanıtı **ve** metinde başvuru kanıtı; puan ≥ 3 | "Sözleşmeli Personel Alım İlanı", "… 20 sözleşmeli personel alınacaktır" |
| **Süreç duyurusu** | `accept` + `kind: process` | Kura/sınav/sonuç/atama sinyali + personel bağlamı | "Sözlü Sınav Sonuç Listesi", "Görevde Yükselme Sınav Duyurusu" |
| **Haber/duyuru (yeni kapı)** | `reject` | Haber/aktarım dili var, somut başvuru kanıtı yok | "Vali, personel alımı yapılacağını açıklandı", "… müjdesi" |
| **Haber dili + somut kanıt** | `review` | İkisi de var → insan kararı | "Vali, 50 personel alınacağını açıkladı" + "başvurular 01.12.2026'ya kadar" |
| **İhale/mal-hizmet alımı** | `reject` | Başlık/gövde ihale kalıbı | "Personel Taşıma Hizmeti Alımı İhalesi" |
| **Mevzuat/yargı/atama kararnamesi** | `reject` | Yönetmelik, icra, kararname | "Cumhurbaşkanlığı Atama Kararnamesi Yayımlandı" |
| **Kurum içi sınav** | `accept` + `process` | "mevcut personel / görevde bulunan" bağlamı | "Kurum içi yeterlik sınavı" |
| **Belge metni okunamadı** | `review` | `documentTextMissing` | PDF metin katmanı yok |

**Eşikler:** kabul ≥ 3,0 · inceleme ≥ 1,0 · altı ret. Kanıt kapısı: metinde alım/istihdam
ifadesi yoksa puan ne olursa olsun kabul yok. Başlıkta kanıt yoksa (yalnızca gövde) → `review`.

## 3. Tarih ve durum kuralları (uydurma tarih yasağı)

| Kural | Davranış | Kanıt |
| --- | --- | --- |
| Yılsız ifade ("30 Ekim") | **Tarih üretilmez**, `null` | `src/domain/dates.ts` |
| Gelecekteki yayım tarihi | Geçersiz sayılır → `null` | `sanePublishedDate` |
| Saat yoksa | `00:00` varsayılır ve `timeIsDefault` işaretlenir | `ParsedTurkishDate` |
| Son başvuru günü | Gün **bitene kadar açık** ("son gün" ≠ "kapandı") | `computeStatus` |
| Son tarih yok + 60 günden eski | `closed` (arşiv kopyası) | `STALE_PUBLICATION_DAYS` |
| Son tarih yok + yeni | `unknown` ("başvuru açık" denmez) | `computeStatus` |
| Başvuru başlangıcı gelecekte | `upcoming`, sonra otomatik `active` | `activateStartedJobs` |
| Resmî iptal duyurusu | `cancelled` + gerekçe + sürüm kaydı | `applyWithdrawal` |

## 4. Tekilleştirme ve değişiklik izi

| Anahtar | Ne zaman kullanılır | Eşik |
| --- | --- | --- |
| Kaynak içi kimlik (`sourceKey` + `sourceItemId`) | Aynı kaynak aynı kaydı tekrar gördü | Birebir |
| Resmî ilan numarası | Metinde geçerli referans varsa | Birebir (normalize) |
| Kanonik URL | Sorgu parametreleri temizlenmiş URL | Birebir |
| Kurum + unvan + dönem + metin benzerliği | Diğer durumlar | `DEDUPE_THRESHOLDS`; aralıkta kalan → `review` |
| İptal hedefi | Yalnızca yukarıdaki kanıtlarla | Kanıt yoksa **kapatma yok** |

Her değişiklik `jobRevisions`'a yazılır (içerik, süre, durum, geri çekme) ve kaynak bağı
`jobSources`'ta tutulur. Aynı sinyal ikinci kez görülürse **yeni sürüm yazılmaz** (idempotent;
`tests/list-drain.test.ts`).

## 5. Kesinlik/duyarlılık: ölçülmedi — ve bu bilinçli

| Soru | Cevap |
| --- | --- |
| Gerçek altın küme var mı? | **Hayır.** Sınıflandırma seti 17 **sentetik** kayıt |
| İnsan etiketli kayıt | **0** (`verify:all`: "Gerçek-insan etiketi: 0") |
| Bu denetimde toplanan gerçek kayıt | **30** (20 ilan.gov.tr gözlemi + 10 İçişleri duyurusu) — `humanVerified: false` |
| Duyarlılık/kesinlik iddiası | **Yok.** Ölçülen şey: bilinen hata sınıflarının geri gelmediği (regresyon) |
| Neden? | Etiketleme **insan** kararı; ajan etiketi ölçüm sayılmaz |

**Ölçüm için gereken:** 150 kayıt, insan etiketi, üç sınıf (job / process / reject),
kaynak katmanı ve tarih bilgisiyle. Plan: 06/P1-3.

## 6. Bilinen kapsam boşlukları

1. **PDF metin katmanı olmayan belgeler** (Resmî Gazete'nin bir kısmı) → `review`; OCR yok.
2. **C katmanı duyuru sayfaları** yüksek gürültü; başlık düzeyinde karar verilemeyen kayıt çok.
3. **Çok kadrolu ilan** (ör. 8 unvan × il dağılımı) tek `quota` alanına indirgeniyor — kadro
   kırılımı veri modelinde yok (05/3, R-17).
4. **Yayımdan kaldırılan ilan** (404 olan detay sayfası) ayrı sinyal olarak izlenmiyor;
   yalnızca tarih/süre ve iptal duyurusu ile kapanıyor.
5. **Kaynak bazlı kesinlik** ölçülmedi: hangi kaynağın yanlış pozitif ürettiği bilinmiyor.
