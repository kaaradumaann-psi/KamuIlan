# Kaynaklar ve kapsam

Bu belge kaynak **envanterini ve kapsam politikasını** açıklar; anlık kaynak sağlığı
raporu değildir. 14 Ekim 2026 denetiminde hiçbir resmî kaynağa canlı istek
atılmadı. `src/config/sources.ts` envanteri (15 Ekim 2026 ayrıştırması) 28 kaynak kaydı içeriyor:
15 etkin ve `verified`, 9 etkin ve `scraper-built` (henüz `verified` değil), 4 devre dışı
(`needs-manual-method`). Bu
`verified` sayacı, envanterde saklanan **tarihsel kanıtı** sayar; bugünkü erişimi,
worker çalışmasını, ilan üretimini veya tam kapsamı kanıtlamaz. Sağlık için
`npm run sources:report`, her çalışmanın kapsamı için tarama geçmişini kullanın.

## Durum ve kapsam sözlüğü

| Durum / alan | Anlamı |
| --- | --- |
| `verified` | Kaynak tanımında tarihli bir erişim/yapı gözlemi vardır. Tarihsel bir noktadır; güncel erişim ve kapsam garantisi değildir. |
| `scraper-built` | Adaptör yazılmış, canlı yapı doğrulaması bekleniyor. |
| `accessible` / `method-defined` | Erişim veya yöntem hakkında gözlem vardır; otomatik veri toplama kanıtı sayılmaz. |
| `access-restricted` | Kaynak coğrafi/WAF/oturum engeli döndürmüştür. Engel aşılmaz. |
| `needs-manual-method` / `disabled` | Otomatik toplama kapalıdır veya manuel yöntem gerekir. |
| Tarama `coverageStatus=complete` | Yalnızca o taramada adaptörün açık sayfa/arşiv sonu sinyali doğrulanmış ve bütçe sınırına takılmamıştır. Kaynağın geçmişi veya kurum çapındaki tüm duyurular için garanti değildir. |
| Tarama `coverageStatus=partial` | Sayfa/ayrıntı/işleme sınırı ya da erişim sorunu nedeniyle görülebilir kayıtların bir kısmı ertelenmiş/atlanmıştır. |
| Tarama `coverageStatus=unknown` | Adaptör kapsamı kanıtlayamamıştır. Çalışma durumu `success` olsa bile bu, tam toplama anlamına gelmez. |

HTTP 304 yalnızca o URL'nin temsil ettiği içeriğin değişmediğini bildirir; bu
taramada gezilmeyen sayfaların kapsamını doğrulamaz. Manuel giriş adaptörü canlı
kaynak toplamaz ve kapsam kanıtı üretmez.

## Etkin kaynaklar — kayıtlı tarihsel kanıt ve kod kapsamı

Aşağıdaki kanıt tarihleri `src/config/sources.ts` içindeki kayıtlarla uyumludur.

| Kaynak | Kayıttaki kanıt | Bu denetimde kapsam yorumu |
| --- | --- | --- |
| Resmî Gazete — Çeşitli İlânlar | 12.10.2026 indeks/PDF örneği; 13.10.2026'da tarayıcı yedeğiyle 5 PDF işlenen kullanıcı-ağı koşumları | Sayfalama yalnızca açık son sayfa işaretiyle `complete` olur. PDF/ayrıntı bütçesi dolarsa `partial`; indeks veya sayfa bitişi belirsizse `unknown`. Tam gazete arşivini kapsadığı ileri sürülmez. |
| ilan.gov.tr — Personel | 12.10.2026'da 157 kayıt/14 sayfa gözlemi; 13.10.2026'daki tarihsel koşumda beş sayfada 60 satır görülüp 40 kayıt işlenmiş | Güncel adaptör boş sayfayı ancak açık "sonuç yok" metniyle son kabul eder; boş kapsayıcı tek başına yetmez. Tekrarlanan ilan kimliği `unknown`, sayfa/ayrıntı bütçesi `partial` üretir. Bu sayılar bugünkü canlı kapsam değildir. |
| ÖSYM — Duyurular | 12.10.2026 liste ve duyuru örnekleri | Sayfalama, yinelenen ilan kimlikleri ve sayfa sonu sinyaliyle denetlenir; sayfa/ayrıntı sınırı `partial`, belirsiz bitiş `unknown` olur. AİS giriş alanı kapsam dışıdır. |
| İŞKUR — Kamu Memur Alımı | 13.10.2026 kullanıcı ağında 3 ham kayıt döndüren tarihsel canlı koşum | Ortak HTML liste adaptörü sayfalama bitişini ve tekrarları kontrol eder; tek sayfa otomatik olarak tam sayılmaz. Ayrıntı bütçesi ve sayfa üst sınırı uygulanır. |
| İŞKUR — Kurum Dışı Kamu İşçi Alımı | 13.10.2026 kullanıcı ağında 3 ham kayıt döndüren tarihsel canlı koşum | İŞKUR kamu memur kaynağıyla aynı ortak liste/pagination korumaları. Ham kayıt sayısı personel ilanı sayısı değildir. |
| Kariyer Kapısı | 13.10.2026 kullanıcıdan alınan gerçek liste/detay HTML'i ve 27 satırlık tarihsel koşum | Önce HTTP, gerektiğinde Playwright. Açık "ilan yok" metni yalnız o koşumdaki sayfa için terminal sinyaldir; tarihsel arşiv tamlığı değildir. Tekrarlanan ilan kimliği `unknown`, sayfa/ayrıntı bütçesi `partial` olur. Bugünkü tarayıcı erişimi doğrulanmadı. |
| MEB Personel GM (RSS) | 13.10.2026'da RSS'ten 50 öğe okunan tarihsel koşum; önceki koşumlarda yeni kayıt sınırı 30 | RSS geçmiş arşivinin tamamı olduğuna dair kanıt yoktur; adaptör kapsamı `unknown` bırakır. 50 öğe / 30 yeni kayıt tam arşiv demek değildir. |
| SBB Kamu İlanı | 13.10.2026 kullanıcı ağında 4 ham kayıt; 12.10.2026'da başka ortamdan alınan 403 gözlemi | Ortamlar arası sonuçlar çelişkilidir; 14.10'da yeniden denenmedi. WAF aşılmaz. Sayfa sonu/tekrar/üst sınır denetimleri çalışır; güncel sağlık bilinmiyor. |
| Kurum duyuru sayfaları (15 kaynak) | Envanterde 13.10.2026 tarihli sayfa/koşum kanıtı bulunan kayıtlar | Sağlık, Adalet, İçişleri, Göç İdaresi, AFAD, SGK, DSİ, KGM, TKGM, TÜBİTAK, YÖK, BDDK, SPK, EPDK ve TMSF ortak AnchorList adaptörünü kullanır. Açık son-sayfa işareti yoksa kapsam `unknown`; tekrar eden ilan kimliği farklı URL ile gelse de `unknown`; sayfa/ayrıntı sınırı veya alınamayan sonraki sayfa `partial` olur. 14.10'da canlı yapı denetimi yapılmadı. |

### Etkinlik ve tarihsel kanıtın sınırları

- 15 etkin kayıt `verified` statüsünü taşıyor; bu, 15 kaynağın **bugün** sağlıklı
  olduğunu veya hepsinin tam arşiv sunduğunu göstermez. Özellikle genel kurum
  sayfalarında bir sayfayı açmak/örnek satır görmek, kaynağın tarihsel bütünlüğünü
  kanıtlamaz.
- 13.10.2026'da listelenen ham kayıt sayıları kaynak yanıtı/adaptör gözlemidir;
  sınıflandırma sonrasında kabul edilen ilan sayısı değildir.
- GİB, TÜİK, RTÜK ve İŞKUR e-Şube `needs-manual-method`/devre dışı durumundadır;
  otomatik tarama yaptıkları iddia edilmez. e-Şube oturum ve form postback'i
  gerektirir; diğer üç kaynak için otomatik yol yeniden değerlendirilmelidir.
- Planlı ama tek bir adaptörle temsil edilmeyen 4 toplu grup ayrı tutulur:
  devlet üniversiteleri, üniversite hastaneleri, büyükşehir belediyeleri,
  il/ilçe belediyeleri. Resmî Gazete/ilan.gov.tr üzerinden dolaylı kapsama
  **eksiksiz** denemez.

## Sayfalama ve işlem sınırları (kod denetimi: 14.10.2026)

Kodda `list/page cap`, seçilen ilan sayısı ve ayrıntı bütçesi farklı sınırlardır.
`src/ingest/pipeline.ts:detailFetchBudget` bir taramada `pdf-index` için 25,
`html-list` için 8, `browser` için 5 ayrıntı isteği verir. Aşağıdaki sayılar
kodda görülen üst sınırlardır; kaynakların gerçekte bu kadar sayfa sunduğu veya
bütçe boyunca erişilebilir olduğu anlamına gelmez.

| Adaptör / kaynak ailesi | Liste taraması ve çıktı üst sınırı | Ayrıntı bütçesi / yöntem | Kapsam sınırı ve bilinen dışlamalar |
| --- | --- | --- | --- |
| Resmî Gazete — `resmigazete-cestili-ilanlar` | Bugün + önceki gün; her tarihli “Çeşitli İlânlar” bölümü en çok 10 sayfa | Kaynak metodu `pdf-index`: en çok 25 PDF/koşum; PDF başına en çok 15 MiB, 16 sayfa ve 60.000 karakter | Daha eski arşiv günleri bu taramada yoktur. Yargı (`-2`), ihale (`-3`) ve Merkez Bankası (`-5`) bölümleri kapsam dışıdır. OCR yoktur. Son sayfa işareti yoksa **unknown**; bütçe/PDF hatası veya sayfa atlanması **partial**. |
| ilan.gov.tr Personel | `currentPage` ile en çok 20 liste sayfası; toplam en çok 40 çıktı (iç ilan + dış bağlantı satırı) | `html-list`: en çok 8 iç detay isteği; dış “İlana Git” satırları ayrıntı indirmeden çıkabilir | HTTP ilk sayfası satırsızsa Chromium yedeği denenir; sonraki HTTP sayfa hatası artık önceki satırları koruyup `partial` döndürür. Açık “sonuç yok” olmadan boş sayfa ve yinelenen sayfa kimliği tamlık kanıtı değildir. Kurumların tüm ilan/arsiv evreni değildir. |
| ÖSYM — Duyurular | En çok 10 görünür/izlenebilir sayfa; aday listesi kod üst sınırı 25 | `html-list`: efektif en çok 8 detay isteği/koşum (`min(25, 8)`) | AIS girişi kapsam dışıdır. PDF/Word bağlantıları ek olarak kaydedilir; dosya içeriği indirilmez, PDF/Word metni çıkarılmaz. Pager sonu doğrulanamazsa **unknown**; hata/bütçe ertelemesi **partial**. |
| Kariyer Kapısı | En çok 10 sayfa; en çok 40 çıktı | `html-list`: en çok 8 iç `IlanDetay` sayfası; dış başvuru satırları detay bütçesi harcamaz | Önce HTTP, satır yoksa Chromium; iç detaylar yalnız bütçedeki sayıda okunur. “Boş kapsayıcı” tek başına boş arşiv değildir. Dış başvuru sayfası içerikleri genel olarak takip edilmez. |
| SBB Kamu İlanı | En çok 10 sayfa ve 300 liste satırı | Detay sayfası isteği yapılmaz; ilan başlığı/kurum/tarih ve liste özetiyle çalışır | Resmî sayfada açık son sayfa doğrulanmazsa **unknown**; 10/300 sınırı veya sonraki sayfa hatası **partial**. 304 o çalışmada sayfaları yeniden doğrulamaz. WAF/403 aşılmaz. |
| İŞKUR + 15 etkin kurum duyuru kaydı (`anchor-list.ts`) | HTML listesi için varsayılan en çok 10 sayfa. Yapılandırılmış `maxItems`: İŞKUR 30; genel kurum adaptörü 25 | Detay alma varsayılan olarak açık: efektif seçim `min(maxItems, 8)`; İŞKUR/kurum kaynağı koşum başına en çok 8 yeni/eksik detay satırı üretir | Başlık/yol seçicisi kurum sayfalarının tümünü veya yalnız personel ilanlarını kanıtlamaz; genel haber/duyuru listesi sınıflandırmada elenir. Açık bir boş-sonuç bildirimi sıfır öğe döndürebilir ama kapsam **unknown** kalır; açık son sayfa yoksa da **unknown**; tekrar/erişim ve ayrıntı sorunu kapsama notuna yansır. |
| MEB Personel (aynı `anchor-list.ts`, RSS modu) | RSS tek uç noktadan okunur; `maxItems=30` yapılandırması | `html-list`: efektif seçim `min(30, 8)`; aynı koşumda en çok 8 yeni/eksik kayıt ayrıntısıyla işlenebilir | RSS sayfa/arşiv sonunu ve tarihe göre eksiksizliği kanıtlamaz; kapsam **unknown**, ayrıntı ertelenmesi varsa **partial**. Yapısal olarak geçerli ama öğesiz RSS de sıfır öğe + **unknown** verir; bozuk/uyuşmayan biçim hata olarak kalır. Önceki tarihsel 50 öğe gözlemi tam arşiv kanıtı değildir. |
| Elle giriş ve kapalı kayıtlar | Otomatik liste taraması yok | Otomatik ayrıntı isteği yok | GİB, TÜİK, RTÜK ve İŞKUR e-Şube etkin otomatik kaynak sayılmaz; manuel yöntem/teknik inceleme gerekir. |

`complete` bir tarama için adaptörün açık bitiş sinyali gerekir (ortak yardımcıda
engelli “sonraki” kontrolü veya kendine işaret eden `rel="last"`; ilan.gov.tr ve
Kariyer Kapısı'nda kaynağa özgü açık boş liste metni de kullanılabilir). Sonraki
sayfa işareti hiç görülmemesi tek başına bitiş değildir. Aynı sayfa/ilanın
tekrarı veya 304 ile yeniden doğrulanamayan sayfa `unknown`; istek, sayfa, PDF,
çıktı ya da detay bütçesi yüzünden bilinen atlama `partial` olmalıdır. Bu
statüler yalnız o koşumun gözlem sınırını anlatır; kaynağın geçmiş veya tüm
kurumlar çapındaki duyuru evrenini ispatlamaz.

## Tarama ve doğrulama

Per-source coverage mantığı `src/sources/adapters/` altında uygulanır:

- `resmigazete.ts`, `ilan-gov-tr.ts`, `osym.ts`, `sbb-kamuilan.ts`,
  `kariyerkapisi.ts` sayfaları izler; üst sınır, döngü, yinelenen ilan kimliği,
  erişim hatası ve açık bitiş sinyali ayrı kaydedilir.
- `anchor-list.ts` ortak kurum/İŞKUR listelerinde URL yerine kaynak ilan kimliğini
  de yinelenme kontrolünde kullanır. MEB RSS arşiv bütünlüğünü doğrulayamadığı
  için `unknown` bırakır.
- `manual-entry.ts` otomatik toplama yapmaz. Adaptör kapsam bildirmezse pipeline
  varsayılan olarak `unknown` yazar.
- Kapsam alanları her `scrapeRuns` kaydında `coverageStatus` ve `coverageNote`
  olarak tutulur. Pipeline, `partial` kapsamı `partial` tarama olarak gösterir;
  `unknown` kapsamı ise açıklamasıyla kaydeder ve diğer hata yoksa çalışma
  `success` olabilir. Worker'ın kuyruk işi başarısı tek başına tamlık kanıtı
  değildir.

## Kaynak sağlığı nereden izlenir

- Arayüz: **/kaynaklar** (durum, son başarılı tarama, hata sayısı ve kaynak kapsamı).
- API: `GET /api/sources`, `GET /api/sources/:key/status`.
- Yönetim: **/yonetim → Kaynaklar / Taramalar**.
- Komut satırı: `npm run sources:report` veya `npm run sources:report -- --json`.
- Canlı doğrulama: yalnız yetkili/ağ erişimli ortamda, explicit `--live` ve
  `--max-requests/--max-pages/--max-details/--min-delay-ms` sınırlarıyla. PowerShell
  örneği ve kanıt alanları: [quality/OFFLINE-VERIFY.md](./quality/OFFLINE-VERIFY.md).

## Yeni kaynak ekleme

Adım adım kılavuz: [source-onboarding.md](./source-onboarding.md).
