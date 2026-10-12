# Kaynaklar ve kapsam

Bu belge **gerçek durumu** yazar. Hiçbir kaynak doğrulanmadan "entegre" sayılmaz.

Durum sözlüğü (`src/config/sources.ts`):

| Durum | Anlamı |
| --- | --- |
| `verified` | Bu ortamdan canlı erişildi, ilan listesi okundu ve `verificationEvidence` alanına kanıt yazıldı. |
| `scraper-built` | Adaptör yazıldı, canlı doğrulama henüz yapılmadı. **Doğrulanmış sayılmaz.** |
| `accessible` | Kaynağa erişilebiliyor ama otomatik çekim için ek yöntem gerekiyor (ör. tarayıcı). |
| `method-defined` | Toplama yöntemi belirlendi, doğrulama bekliyor. |
| `access-restricted` | Erişim coğrafi/WAF engeliyle kapalı. Engel AŞILMAYA ÇALIŞILMAZ. |
| `needs-manual-method` | Manuel/insan katkısı gerekiyor; otomatik tarama yok. |
| `disabled` | Kasıtlı olarak kapalı. |

## Kayıtlı kaynaklar

| Kaynak anahtarı | Kurum | Yöntem | Durum | Aralık | Kanıt |
| --- | --- | --- | --- | --- | --- |
| `resmigazete-cestili-ilanlar` | Resmî Gazete | `pdf-index` | `verified` | 60 dk | 12.10.2026: `/fihrist?tarih=2026-10-12` → `20261012-4.htm` içinde 7 ilan başlığı + PDF bağlantıları; PDF metin katmanı okundu. |
| `ilan-gov-tr-personel` | Basın İlan Kurumu | `html-list` | `verified` | 60 dk | 12.10.2026: `personel-alimi?ats=5` listesi açıldı (157 ilan / 14 sayfa), kurum + resmî ilan no + detay bağlantıları görüldü. |
| `osym-duyurular` | ÖSYM | `html-list` | `verified` | 120 dk | 12.10.2026: duyuru listesi açıldı; sınav/başvuru tarihleri ve ücret bilgisi görüldü. AİS (`ais.osym.gov.tr`) oturum gerektirir, kapsam dışıdır. |
| `iskur-kamu-memur-alim` | İŞKUR | `html-list` | `scraper-built` | 120 dk | Listeleme adresleri (`/ilanlar/kamu-memur-alim-ilanlari/`) tanımlı; adaptör yazıldı, canlı doğrulama bekliyor. |
| `iskur-kurumdisi-kamu-isci` | İŞKUR | `html-list` | `scraper-built` | 180 dk | Kurum dışı kamu işçisi alım listesi; adaptör hazır, doğrulama bekliyor. |
| `kariyerkapisi-isealim` | Kariyer Kapısı (Cumhurbaşkanlığı İK) | `browser` | `accessible` | 60 dk | Sayfa JavaScript ile doldurulur ve giriş e-Devlet üzerindendir. Tarayıcı gerektirir: `npx playwright install chromium`. Aksi halde adaptör "tarayıcı yok" hatası döner, sahte veri ÜRETMEZ. |
| `meb-personel-duyurular` | MEB Personel GM | `html-list` | `method-defined` | 180 dk | Haber listesi (`/www/haberler/kategori/1`) görüldü; içerik çoğunlukla öğretmen yer değiştirme/atama olduğundan sınıflandırma çoğunu reddeder. |
| `kamuilan-sbb` | SBB Kamu İlan | `html-list` | `access-restricted` | 120 dk | 12.10.2026: HTTP 403 "Geographic Restriction" (WAF). Türkiye'den çalışan kurulumda denenmelidir; kısıt aşılmaz. |
| `iskur-esube-acik-is` | İŞKUR e-şube | `manual-entry` | `needs-manual-method` (kapalı) | 360 dk | Oturum/arama tabanlı; otomatik çekim kapalı. Kaynak kaydı kapsam raporunda görünür. |

**Not:** `iskur-esube-acik-is` kaydı `manual-entry` adaptörüne bağlıdır ve kapalıdır;
otomatik tarama yapmaz.

## Planlanan kaynaklar (henüz entegre edilmedi)

`PLANNED_SOURCES` listesinde **18** kayıt vardır ve arayüzde "Planlanan kaynaklar
(henüz entegre edilmedi)" başlığı altında açıkça gösterilir: Sağlık Bakanlığı,
Adalet Bakanlığı, İçişleri Bakanlığı, Göç İdaresi, AFAD, SGK, GİB, TÜİK, DSİ,
KGM, Tapu ve Kadastro, TÜBİTAK, YÖK, devlet üniversiteleri (125 kurum),
üniversite hastaneleri, büyükşehir belediyeleri, il/ilçe belediyeleri ve
düzenleyici-denetleyici kurumlar (BDDK, SPK, EPDK, RTÜK, TMSF...).

Bu kurumların ilanlarının bir kısmı Resmî Gazete ve ilan.gov.tr üzerinden dolaylı
olarak kapsanır; kendi sayfaları doğrulanmadan "entegre" sayılmazlar.

## Kapsam politikası (dürüstlük ilkeleri)

1. **"Tüm ilanlar" iddiası yoktur.** Hiçbir sistem tüm kamu ilanlarını garanti
   edemez; arayüz her zaman son başarılı taramayı, kaynak durumunu ve bilinen
   boşlukları gösterir.
2. **Doğrulama kanıtı zorunludur.** `verified` durumu yalnızca tarih + yöntem +
   görülen veri açıklamasıyla verilir.
3. **Engel aşılmaz.** CAPTCHA, oturum duvarı, WAF/coğrafi kısıt veya robots
   yasağı varsa kaynak `access-restricted`/`needs-manual-method` olarak işaretlenir.
4. **Kaynak çöktüğünde ilan silinmez.** Erişilemeyen kaynağın mevcut ilanları
   veritabanında kalır; yalnızca kaynak sağlığı işaretlenir.
5. **Yöntem kaynak başına en ucuz ve en kararlı olandır.** Önce HTML/metin,
   gerekiyorsa PDF metin katmanı, en son tarayıcı. OCR zorlanmaz; taranmış PDF'ler
   "metin katmanı yok" olarak işaretlenir ve ek olarak saklanır.

## Kaynak sağlığı nereden izlenir

- Arayüz: **/kaynaklar** sayfası (durum, aralık, son başarılı tarama, hata sayısı).
- API: `GET /api/sources`, `GET /api/sources/:key/status`.
- Yönetim: **/yonetim → Kaynaklar / Taramalar** (elle tetikleme, aralık değiştirme,
  bakım işleri).
- Komut satırı: `npm run sources:report` (insan okunur) veya `-- --json` (makine okunur).
- Canlı doğrulama: `SOURCE_LIVE_FETCH=1 npm run test:live` (yalnızca kullanıcı çalıştırır;
  bu ortamdan dış alan adlarına erişim yoktur).

## Yeni kaynak ekleme

Adım adım kılavuz: [source-onboarding.md](./source-onboarding.md).
