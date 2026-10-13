# Uçtan uca doğrulama kaydı — 13 Ekim 2026

Bu kayıt, "her şey çalışıyor mu" sorusuna verilen kanıtların listesidir.
Yöntem: bu geliştirme ortamından devlet sitelerine doğrudan ağ erişimi
olmadığı için her kaynağın resmî liste sayfası **bağımsız bir kanaldan
açıldı**, sayfa yapısı (bağlantı biçimi, tarih biçimi, liste adresi)
adaptörün beklentisiyle karşılaştırıldı; uyumsuzluklar düzeltildi ve
ayrıştırma, gerçek sayfa biçimlerini taklit eden kalıcı testlerle
(`tests/sources.test.ts`) kilitlendi. Uygulamanın kendi tarayıcısıyla
ilk canlı tarama, kullanıcının ağında `npm run test:live` ile doğrulanır.

## Kaynaklar (27 kayıtlı, 26 etkin)

| Kaynak | Liste adresi durumu | Yapı |
|---|---|---|
| Resmî Gazete, ilan.gov.tr, ÖSYM | Önceden canlı doğrulanmış; ÖSYM adresi bu turda da açıldı | Uygun |
| İŞKUR kamu memur / kurum dışı işçi | Adresler bu turda açıldı, liste sayfaları duruyor | Uygun |
| Kariyer Kapısı | Tarayıcı (Playwright) gerektirir — mevcut durum korundu | Koşullu |
| Kamuİlan (SBB) | WAF 403 — kısıt aşılmaz | Erişim kısıtlı |
| İŞKUR e-Şube | Oturum + form gönderimi; otomatik taranamaz | Kapalı (elle yol gösterilir) |
| Sağlık (YHGM) | Ana sayfadaki duyuru bloğu; bağlantılar `/TR-12345/...` | Kalıp genişletildi, test kilitli |
| Adalet | `/duyurular` ana sayfaya düşüyor → doğru adres `/arsiv?type=1` | Düzeltildi |
| İçişleri, Göç İdaresi, AFAD | `/duyurular` doğru ve sunucu taraflı | Uygun |
| SGK | `/duyurular` 404 → doğru adres `/duyuru` | Düzeltildi |
| GİB | `/duyurular` yok → doğru adres `/duyuru-arsivi/guncel` | Düzeltildi |
| DSİ | `/duyurular` hata veriyor → doğru adres `/duyuru/duyuruListe` | Düzeltildi |
| KGM | Eski SharePoint yolu 404 → `/Sayfalar/KGM/SiteTr/Root/Duyurular.aspx` | Düzeltildi, `DuyuruDetay.aspx?Parameter=` kimliği ayrıştırılıyor |
| Tapu ve Kadastro | `/duyurular` doğru; güncel personel ilanı sayfada görüldü | Uygun |
| TÜBİTAK | `/tr/duyurular` 404 → duyurular ana sayfada (`/tr/duyuru/...`) | Düzeltildi |
| YÖK | `/duyurular` 404 → doğru adres `/announcements` | Düzeltildi |
| BDDK | Doğru liste `/Duyuru/Liste`; güncel alım ilanı sayfada görüldü | Düzeltildi |
| SPK | Adres doğru; liste öğeleri JavaScript ile yükleniyor olabilir | İlk canlı taramada görülecek |
| EPDK | Ana sayfa; detaylar `/Detay/Icerik/...` | Uygun |
| RTÜK, TÜİK | Siteler JavaScript uygulaması; düz HTML taraması yapı hatası verir | Not kaynak kaydında açık; ilanları Resmî Gazete/ilan.gov.tr üzerinden de gelir |
| TMSF | `/duyurular` ana sayfaya düşüyor → doğru adres `/tr/Basin/List` | Düzeltildi |

## Bu turda bulunan ve kapatılan hatalar

1. **Eğitim/bölüm/KPSS filtreleri etkisizdi** — form topluyor, sunucuya
   göndermiyordu. Gönderiliyor; test: `tests/jobs-filters-wiring.test.tsx`.
2. **İl filtresi harf duyarsız değildi** — "istanbul" yazan sonuç bulamıyordu.
   Normalize alan eklendi; test: `tests/filters.test.ts` (8 uçtan uca test).
3. **Giriş başarılı olduğu halde kullanıcı giriş ekranında takılıyordu** —
   giriş kapısı, oturum yenilenirken eski bilgiyle geri atıyordu. Kapı artık
   yenileme bitene kadar bekler; test: `tests/app-gate.test.tsx`
   (düzeltmesiz hâliyle kırıldığı kanıtlandı). Gerçek tarayıcıda da doğrulandı.
4. **Oturum okuma istekleri sıkı giriş sınırına takılıyordu** — her
   `/api/auth/*` isteği 10/dk kovasındaydı; uygulama her sayfada oturum
   sorduğu için normal kullanıcı kilitlenebiliyordu. Sıkı kova artık yalnızca
   kimlik POST uçlarında; test: `tests/server.test.ts`.
5. **E2E giriş yardımcısı** yıldızlı etiket ("E-posta *") yüzünden exact
   eşleşmede bulamıyordu — düzeltildi.
6. **Canlı tarama hiç ağa çıkamıyordu (en kritik bulgu)** — varsayılan
   `SCRAPE_USER_AGENT` içindeki Türkçe `ı` karakteri HTTP başlık aralığı
   dışında olduğu için undici her isteği `UND_ERR_INVALID_ARG: invalid
   user-agent header` ile, ağa hiç çıkmadan reddediyordu. Belirti yanıltıcı
   biçimde `status: null` olarak görünüyordu. Kullanıcının canlı koşum
   çıktısıyla yakalandı. Düzeltme üç katmanlı: varsayılan saf ASCII;
   env değeri `toHeaderSafeAscii` ile çevrilir; `HttpClient` tüketim
   noktasında tekrar temizler. Ayrıca hata nedeni (undici `cause` zinciri)
   artık günlüğe ve hata mesajına yazılıyor — bu teşhis o sayede mümkün
   oldu. Test: `tests/fetcher.test.ts` (9 test, başlık eşleşmesi dahil).
   Bu hatanın düzeltilmesi, kullanıcının canlı `npm run test:live`
   koşumunu yeniden yapmasını gerektirir; sonuç bu kayda eklenecektir.
7. **Tek yavaş PDF tüm Resmî Gazete nüshasını düşürüyordu** — UA düzeltmesi
   sonrası ikinci canlı koşumda liste sayfası ve ilk PDF'ler çekildi; bir
   PDF'de sunucu başlıkları 60 sn içinde gelmeyince (`UND_ERR_HEADERS_TIMEOUT`,
   Resmî Gazete sunucularının yavaşlığı; aynı PDF bağımsız kanaldan anında
   açıldı) hata tüm adaptör koşumunu iptal ediyordu. Artık PDF başına hata
   yalıtımı var: indirilemeyen ilan atlanır, not düşülür, kalan ilanlar
   gelir ve atlanan belge sonraki taramada yeniden denenir. Ayrıca başlık
   zaman aşımı bütçesi çağrı bütçesine hizalandı (30→60 sn) ve
   keep-alive 10→4 sn'ye indirildi (bayat soket riski). Test:
   `tests/sources.test.ts` ("tek PDF indirilemezse diğer ilanlar yine de
   gelir").

## Canlı doğrulama koşumu (13.10.2026, kullanıcı ağı — `npm run test:live`)

**17/26 kaynak çalıştı, 292 ham kayıt** döndü (iş ilanı olmayanlar
sınıflandırma hattında elenir; ham kayıt ≠ yayındaki ilan).

Çalışanlar: ÖSYM (25), Sağlık (25), Göç (25), AFAD (25), SGK (25),
DSİ (25), EPDK (25), TÜBİTAK (25), KGM (21), İçişleri (17), YÖK (17),
Adalet (14), Tapu ve Kadastro (11), Kamuİlan-SBB (4), İŞKUR memur (3),
İŞKUR kurum dışı (3), SPK (2). Bu kaynaklar kayıtlarda `verified` +
`lastVerifiedAt: 2026-10-13` olarak işaretlendi.

Kalanlar ve alınan kararlar:

- **ilan.gov.tr, BDDK, TMSF** — `UNABLE_TO_VERIFY_LEAF_SIGNATURE`:
  sertifika kökü Node CA listesinde yok. İstemci artık sistem CA
  deposunu varsayılan paketle birleştiriyor (`loadTrustBundle`);
  yeniden canlı doğrulama bekleniyor.
- **MEB** — liste JS ile yükleniyor; kurumun resmî RSS beslemesine
  geçildi (`meb_iys_dosyalar/xml/rss_duyurular.xml`, bağımsız kanaldan
  doğrulandı). İlk canlı koşum bekleniyor.
- **GİB, TÜİK, RTÜK** — siteler JS uygulaması, düz HTTP içerik
  vermiyor (canlıda doğrulandı). Kayıtları `needs-manual-method` +
  kapalı olarak işaretlendi; personel duyuruları Resmî Gazete /
  ilan.gov.tr / Kariyer Kapısı üzerinden izleniyor. Tarayıcı tabanlı
  yöntem eklenene dek worker bunlara istek atmayacak.
- **Kariyer Kapısı** — yöntem tarayıcı gerektiriyor; kullanıcı
  makinesinde `npx playwright install chromium` çalıştırılmalı.
- **Resmî Gazete** — bölüm sayfası bu koşumda dört denemede de 60 sn'yi
  aştı (sunucu yavaşlığı); güne düşme yedeği eklendi (hata #7).
  Sonraki koşumda yeniden değerlendirilecek.

İkinci canlı koşum (aynı gün, 10:14): **19/23 kaynak, 322 ham kayıt.**
MEB RSS ile çalıştı (30 kayıt); Kariyer Kapısı tarayıcısı açıldı ancak
sayfada ilan bağlantısı bulunamadı (kurum seçim listesi görünüyor —
adaptöre gerçek bağlantı biçimini raporlayan tanı notu eklendi,
düzeltme gözleme dayanacak). Kapanan bulgular:

9. **Kariyer Kapısı adaptörü gerçek sayfa yapısına uyarlandı** — liste
   bağlantı değil tablo satırı: kurum / ilan başlığı / bitiş tarihi
   hücrelerden okunur; detay adresi (/IlanDetay?i=<uuid>) satır
   HTML'inden çıkarılır ve detay sayfası aynı tarayıcı oturumunda
   ziyaret edilerek ilan numarası (ILN...), başvuru tarihleri ve tam
   metin alınır. Yapı, kullanıcının gönderdiği liste + detay ekran
   görüntüleriyle doğrulandı. Test: `tests/sources.test.ts`
   (tablo/detay ayrıştırma fikstürleri).

8. **Ara sertifika kovalaması (AIA)** — sistem CA birleşimi yetmedi;
   kök neden sunucunun ara sertifikayı göndermemesi çıktı (tarayıcılar
   AIA adresinden indirir, Node indirmez). `HttpClient` artık eksik
   halkayı AIA üzerinden tamamlayıp doğrulamayı **açık** tutarak yeniden
   deniyor; indirilen sertifika güven paketiyle zincir doğrulamasından
   geçmek zorunda. Test: `tests/fetcher.test.ts` (yardımcı birim
   testleri).

Üçüncü canlı koşum (13.10.2026, 10:59): **22/23 kaynak, 351 ham kayıt.**
AIA düzeltmesi doğrulandı: BDDK (25) ve TMSF (4) çalıştı, kayıtları
`verified` yapıldı; ilan.gov.tr sayfayı açtı (200) ancak liste JS ile
dolduğu için 0 satır döndü. Kariyer Kapısı'nda tanı notu sorunu
gösterdi: ilanlar <table> değil div satırları (ayrıştırıcıya bağlantıdan
satır kuran yedek eklendi). Resmî Gazete, UA biçimi deneyine rağmen
başlık zaman aşımında kaldı — yavaşlatma istemci kimliğine değil
bağlantının tarayıcı olup olmadığına bakıyor. Bu iki kaynağa da
Kariyer Kapısı modeliyle **gerçek tarayıcı yedeği** eklendi
(paylaşılan `src/sources/browser-session.ts`); sıradaki canlı koşum
doğrulayacak.

## Koşum sonuçları (13.10.2026)

- Birim/entegrasyon testleri: **220/220 yeşil** (23 dosya)
- Tarayıcı testleri (Playwright, gerçek Chromium): **9/9 yeşil**
  (bu ortamda tarayıcı, kaynaktan derlenen NSS kütüphaneleriyle çalıştırıldı)
- Tip denetimi, lint, üretim derlemesi: temiz
- Üretim önizlemesi: HTTP 200

## Bilinen sınırlar (dürüstlük)

- Yeni 18 kurum "adaptörü yazılmış" durumundadır: adres+yapı bağımsız
  incelemeyle doğrulandı, ancak uygulamanın kendi taramasının ilk canlı
  sonucu kullanıcının ağında görülecektir. Yapı uymayan kaynak sessizce
  boş dönmez; hata kaydeder ve kaynak sağlığında görünür.
- TÜİK/RTÜK (ve muhtemelen SPK) listeleri JavaScript ile yüklenir; düz
  HTML adaptörü bunlarda yapı hatası verir. Çözüm tarayıcı adaptörüdür;
  ilanları merkezî kaynaklardan da gelmektedir.
- 125 üniversite, üniversite hastaneleri ve belediyeler tek tek taranmaz;
  merkezî kaynaklarla (Resmî Gazete, ilan.gov.tr) dolaylı kapsanır ve
  arayüzde "planlanan/dolaylı" olarak açıkça gösterilir.
