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

## Koşum sonuçları (13.10.2026)

- Birim/entegrasyon testleri: **199/199 yeşil** (22 dosya)
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
