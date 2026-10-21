# Kadronerede.com Tersine Mühendislik İnceleme Raporu

**Hedef:** https://kadronerede.com  
**Araç:** https://github.com/morluto/rea (REA — Reverse Engineer Anything)  
**Tarih:** 2026-10-21  
**Hazırlayan:** Arena agent (branch: `arena/3432c91a-kamuradar`)

---

## 1. Özet

Kadronerede, Türkiye'deki kamu personel alım ilanlarını (memur, sözleşmeli personel, kamu işçisi, akademik kadro) resmi kaynaklardan toplayan, yapılandıran ve ücretsiz sunan bağımsız bir sitedir. **Resmi bir kurum değildir.**

Site, verisini **ilan.gov.tr (Basın İlan Kurumu)** ve **İŞKUR e-Şube**'nden günde birkaç kez otomatik olarak çeker. İlan metinlerinden şartlar (kadro, öğrenim, bölüm, KPSS puan türü/puanı, yaş, il) yazılımla çıkarılır; özetler yapay zekâ yardımıyla yazılıp otomatik denetlenir. Tüm sayfalar sunucu tarafından render edilen HTML'dir; kimlik doğrulama, API anahtarı veya OAuth yoktur. Anonim, düz HTTP GET ile erişilebilir.

İşbu incelemenin merkezi sonuç: **kadronerede, ilan.gov.tr'yi bir tarayıcı/HTTP istemcisiyle tarayarak, HTML'den ayrıştırarak ve yapılandırılmış olarak tekrar yayımlayan bir agregatördür.** Kendi genel-utilities API'si yoktur (`/api/` robots.txt ile engellenmiş, sadece iç kullanımdır); dışarıya açık olan şey, AI asistanları ve arama motorları için hazırlanmış `openapi.json` + `llms.txt` tanıtım dosyalarıdır.

---

## 2. rea Aracı Nedir ve Bu İncelemede Nasıl Kullanıldı

**REA (morluto/rea)** — "Reverse Engineer Anything", bir agent/MCP tabanlı tersine mühendislik aracıdır. İndirme: `npx rea-agents setup`; CLI: `npm install --global rea-agents`.

Web siteleri için REA, **Chrome DevTools Protocol (CDP)** üzerinden kullanıcının kendi Chrome ailesi tarayıcısına pasif olarak bağlanır ve aşağıdaki değerleri döndürür:

| REA işlemi | Neleri yakalar |
|---|---|
| `inspect_web_page` | DOM yapısı, erişilebilirlik düğümleri, scriptler, kaynaklar, yanıt/DOM meta verileri, ağ ve konsol meta verileri, WebSocket kare boyutları, web çalışanları, depolama |
| `analyze_web_bundle` | Komut dosyalarını çalıştırmadan ayrıştırır; komut dosyası kenarları, yol/uç nokta adayları, satıcı parmak izleri, WebMCP bildirimleri, kaynak haritası/çekilmiş kaynak delilleri |
| `observe_web_session` | Yeniden yükleme, SPA gezinmesi, yönlendirme, hata, yaşam döngüsü ve hedef sonlandırma meta verileri |
| `capture_web_screenshot` | Görünlü görünüm ekran görüntüsü (PNG) |
| `discover_webmcp_tools` | CDP WebMCP alanı üzerinden kayıtlı araçlar ve `input_schema` bildirimleri |

**Önemli sınırlama:** REA, genel bir tarayıcı otomasyonu/uzaktan kontrol arayüzü değildir; pasif gözlemsel tersine mühendislik yapar.

**Bu oturumda ne yapıldı:** Sandbox ağ kısıtlaması doğrudan `kadronerede.com`'a `curl` üzerinden erişimi engellediği (HTTP 000) ve REA'nın yerel Chrome tarayıcı kurulumu gerektirmesi nedeniyle, REA'nın yakalayacağı türdeki deliller (DOM, script kaynakları, ağ istekleri, ekran görüntüleri) **fetch_page aracıyla elde edilebilen salınabilir sayfa içeriği üzerinden el ile yeniden oluşturuldu**. Bu yöntem, sayfa yapısı, URL kalıpları, veri kaynağı ve makine-erişimi belgeleri açısından eşdeğer bir sonuç verir; tarayıcı seviyesindekiJS ayrıntıları (ör. hangi JS paketi hangi `/api/` iç ucunu çağırır) bu raporun kapsamında doğrulanamadı.

---

## 3. Site Genel Bakış

### 3.1 Amacı ve kapsam
- Kamu personel alım ilanlarını (memur, sözleşmeli, işçi, akademik) toplar
- Resmi kaynaklardan toplanır, şartları ayıklanır; kayıt yok, ücret yok
- Dil: Türkçe; içerik kaynağı olarak `kadronerede.com` gösterilerek alıntılanabilir

### 3.2 Ana sayfa metni (örnek)
> "Kamu personel alım ilanları — Resmi kaynaklardan toplanır, şartları ayıklanır. Kayıt yok, ücret yok. 122 ilanda başvuru açık, 78 akademik ilan, 146 ilan arşivde."

### 3.3 İlan örneği (Elmakaya Belediye Başkanlığı, ID 43)
- URL: `https://kadronerede.com/ilan/elmakaya-belediye-baskanligi-ilk-defa-atanmak-uzere-memur-alim-ilani-43`
- Kurum: Elmakaya Belediye Başkanlığı, Kadro: 1 (Muş), Memur, Lisans, KPSS P3
- Başvuru: 16–21 Ekim 2026 (E-posta, şahsen veya posta), Sınav: 6 Kasım 2026
- Özet: "Bu özet ilan verisinden yapay zekâ yardımıyla yazıldı ve otomatik denetlendi"
- Kaynak: ilan.gov.tr (ilan no 2226098), Son kontrol: 21 Ekim 2026 12:30
- Her ilan sayfasında: **resmi kaynak bağlantısı, kaynak adı ve son kontrol zamanı** yer alır

---

## 4. Veri Çekim Yöntemi ("Nasıl Veri Çekiyor")

`/llms.txt` ve `/kaynaklar` sayfalarından doğrudan elde edilen gerçekler:

| Özellik | Değer |
|---|---|
| **Kaynak 1** | ilan.gov.tr (Basın İlan Kurumu portalı) |
| **Kaynak 2** | İŞKUR e-Şube (`esube.iskur.gov.tr`) |
| **Çekim sıklığı** | Günde birkaç kez, otomatik |
| **İstek davranışı** | Kaynak sitelere yük bindirmemek için istekler **yavaş ve seyrek** yapılır |
| **Dayanıklılık** | Bir kaynak çalışırsa diğerleri etkilenmez |
| **Son başarılı çekim** | ilan.gov.tr: 21 Ekim 2026 12:30; İŞKUR: 21 Ekim 2026 12:31 |
| **Planlanan kaynaklar** | Kariyer Kapısı, Resmi Gazete İlan Bölümü, Cumhurbaşkanlığı SBB Kamu İlanları |
| **Ayrıştırma** | Resmi ilan metninden yazılımla şartlar çıkarılır (kadro, öğrenim, bölüm, KPSS, yaş, il) |
| **Özetleme** | Yapay zekâ yardımıyla yazılır, otomatik denetlenir |
| **Süresi dolan ilanlar** | Silinmez, "başvuru sona erdi" etiketiyle kalır |
| **Kişisel veri** | Atama kararı ve sonuç listesi gibi kişi adı içeren belgeler sitede yoktur |
| **Erişim modeli** | Anonim; kayıt/API anahtarı/OAuth yok; tüm herkese açık sayfalar düz HTTP GET ile okunur |
| **Nezaket kuralı** | Saniyede birden fazla istek gönderilmemeli (site haritası/llms.txt çoğu iş için yeterli) |
| **İletişim** | info@kadronerede.com |

### 4.1 Veri akışı (tahmini)
```
ilan.gov.tr / İŞKUR e-Şube
      ↓  (günde birkaç kez, yavaş/seyrek HTTP çekim)
HTML ilan listeleri + detay sayfaları
      ↓  (yazılımla ayrıştırma / extraction)
Yapılandırılmış alanlar (kurum, kadro, tarihler, KPSS, bölüm, il, …)
      ↓  (AI yardımıyla özetleme + otomatik denetim)
Sunucu-render HTML sayfalar ( /ilan/{slug}, /ilanlar, /kurum/{kurum}, … )
      ↓  (kullanıcı / arama motoru / AI asistanı okur)
```

---

## 5. URL Yapısı ve Sayfa Türleri

`/llms.txt`'teki "Adres kalıpları" bölümü:

| Kalıp | Açıklama |
|---|---|
| `/ilan/{slug}` | Tek ilan; kadrolar, şartlar, tarihler, kaynak bağlantısı, son kontrol zamanı |
| `/ilanlar` | Tüm açık ilanlar (süzgeçler: `il`, `kurum`, `ogrenim`, `KPSS`, `sekme`, `sirala`, `sayfa`…) |
| `/il/{il}` | İldeki açık ilanlar (ör. `/il/ankara`) |
| `/kurum/{kurum}` | Kurumun açık ilanları ve geçmiş alımları |
| `/bolum/{bolum}` | Bölüm mezunlarının başvurabileceği ilanlar (ör. `/bolum/hemsirelik`) |
| `/unvan/{unvan}` | Unvana göre ilanlar (ör. `/unvan/hemsire`) |
| `/ogrenim/{duzey}` | Öğrenim düzeyine göre ilanlar (lise, onlisans, lisans…) |
| `/nitelik-kodu/{kod}` | ÖSYM nitelik koduna göre ilanlar |
| `/taban-puanlar/{unvan}` | Dönemlere göre KPSS taban puanları |
| `/kpsssiz` | KPSS şartı aranmayan ilanlar |
| `/takvim` | Başvuru takvimi (`/takvim.ics` iCalendar da mevcut) |
| `/haberler` | Günlük yeni ilan bülteni (ör. `/haberler/2026-10-20-yeni-kamu-ilanleri`) |
| `/rehber/*` | Rehber makaleleri (KPSS'siz alım, yaş sınırı, engelli kadro, …) |
| `/hesaplama/*` | Hesaplama araçları (memur maaşı, zam farkı, ek ders, emekli ikramiyesi) |
| `/istatistik` | Aylık kadro, kurum/bölüm/il bazlı istatistikler |
| `/harita` | 81 ilde açık ilan ve kadro sayıları |
| `/kaynaklar` | Çekim kaynakları ve son başarılı çekim zamanları |
| `/hakkinda`, `/gizlilik`, `/kvkk`, `/cerez-politikasi`, `/kullanim-kosullari` | Yasal/bilgi sayfaları |

İlan URL kalıbı: `/ilan/<slug>-<id>` (ID, son Path parçasıdır, örn. `...-43`).

### 5.1 Listeleme süzgeçleri (`/ilanlar`)
OpenAPI (`/openapi.json`) declares these query params on `GET /ilanlar`:

`q`, `il`, `ilce`, `kurum`, `tur` (memur/sozlesmeli/isci/akademik/diger), `ogrenim`, `bolum`, `unvan`, `nitelik` (4 hane ÖSYM kodu), `kpsssiz` ("1"), `engelli` ("1"), `son3gun` ("1"), `sekme` (acik/yakinda/akademik/arsiv), `sirala` (son-basvuru/kadro/yeni), `sayfa` (2–999).

Yanıt içerik türü: `text/html` (JSON veri API'si yok; her şey HTML sayfa olarak sunulur).

---

## 6. Makine Erişimi ve Dokümanlar (AI / Arama Motoru Odaklı)

Sitenin amacı, insanın yanı sıra AI asistanlarının da kolayca okuyabilmesidir:

| Dosya | İçerik | URL |
|---|---|---|
| `openapi.json` | OpenAPI 3.1.0, tüm açık sayfa adresleri ve `/ilanlar` süzgeç parametreleri (yanıtlar HTML) | https://kadronerede.com/openapi.json |
| `llms.txt` | AI asistanları için kısa tanıtım, kaynaklar, adres kalıpları | https://kadronerede.com/llms.txt |
| `robots.txt` | Tüm botlar serbest; `/admin`, `/api/`, `/bana-uygun`, `/favoriler`, `/abonelik/`, `/*/belge`, `/*/takvim` kapalı | https://kadronerede.com/robots.txt |
| `auth.md` | Kayıt/API anahtarı/OAuth yok; anonim erişim; `Authorization` başlığı gönderilmemeli | https://kadronerede.com/auth.md |
| `/.well-known/api-catalog` | RFC 9727 API kataloğu; `openapi.json` ve `llms.txt` işaret eder | https://kadronerede.com/.well-known/api-catalog |

Sitemap'ler: `/sitemap.xml` ve `/taban-puanlar/sitemap.xml`.

Telegram: `https://t.me/kadronerede` (yeni ilanlar çıktığı gün bildiriliyor).

---

## 7. Teknik Gözlemler (REA'nın Yakalayabileceği Delillerin Tahmini)

REA'nın `inspect_web_page` / `analyze_web_bundle` işlemleriyle şu şekilde gözlemlenebilecek unsurlar:

1. **Sunucu-render HTML:** Sayfaların tamamı ilk HTTP yanıtında tam içerikle gelir (fetch_page'den alınan metin bunu doğruluyor). İlan listeleri ve detayları JavaScript ile doldurulmak zorunda değildir — bu, REA'nın dinamik JS yürütmesine ihtiyaç duymamasını sağlar.
2. **Script/kaynakları:** Sayfalarda interaktiflik için istemci tarafı JS paketleri olabilir (REA bunları `analyze_web_bundle` ile çıkarabilir ve yol/uç nokta adayları türetebilir).
3. **`/api/` iç uçları:** `robots.txt` açıkça `Disallow: /api/` der; bu, sitenin kendi arka uç API'sinin var olduğunu, ancak dışarıya/document edilmediğini gösterir. REA tarayıcı gözlemiyle bu isteklerin kıyakları (frame, kaynak,WebSocket) Yakalanabilir.
4. **Depolama:** Kullanıcı profili/uygunluk sadece tarayıcı çerezinde tutulur (`/bana-uygun`, `/favoriler` çereze dayalı; ajana anlamlı içerik vermez).
5. **Ekran görüntüleri:** REA `capture_web_screenshot` ile görünlü görünüm PNG'i alabilir.

**Doğrulanamayan şeyler (bu oturumda):** İstemci tarafı JS paketlerinin içerikleri, `/api/` iç uçlarının gerçek imzaları ve ağ istek detayları. Bunları doğrulamak için yerel bir Chrome+REA kurulumu veya HAR/Fiddler yakalaması gerekir (REA docs: `web-network-captures.md`).

---

## 8. Kamuradar (Bu Repo) ile Karşılaştırma

Bu depo (`kamuilan`) zaten çok benzer bir mimariye sahip:

| Özellik | kadronerede.com | kamuradar (bu repo) |
|---|---|---|
| Ana kaynak | ilan.gov.tr, İŞKUR e-Şube | ilan.gov.tr (`src/sources/adapters/ilan-gov-tr.ts`), kariyerkapisi, osym, resmigazete, sbb-kamuilan |
| Çekim yöntemi | HTML liste + detay, yazılımla ayrıştırma | HTML liste + detay sayfası; tarayıcıya düşme seçeneği (`browser-session.ts`) |
| İstek nezaketi | Yavaş/seyrek, saniyede en fazla 1 istek | `fetcher.ts` (undici): host başına rate limit, 429/503 Retry-After, üstel geri çekilme, SSRF koruması, CAPTCHA aşılmaz |
| Detay bütçesi | Belirtilmemiş | `ilan-gov-tr` adaptöründe detay istek sayısı bütçeyle sınırlı |
| Veri işleme | AI özet + otomatik denetim | `src/ingest` (dedupe, sanitize, reclassify), `src/classification` |
| Çalışma döngüsü | Günde birkaç kez otomatik | `src/worker` (scheduler, trigger, queue) |
| Açık dokümantasyon | `openapi.json`, `llms.txt`, `auth.md`, `robots.txt` | `docs/` denetim raporları, `source-onboarding.md`, `sources.md` |
| Kimlik doğrulası | Yok (anonim) | Kullanıcı/admin akışları mevcut |

**Sonuç:** kamuradar'ın çekim altyazıphanesi (adapter/fetcher/ingest/worker) zaten kadronerede'nin kullandığı yöntemle neredeyse aynıdır. Fark, kadronerede'nin tarafına açık bir **AI-ödüllü dokümantasyon katmanı** (`llms.txt`, `openapi.json`, `auth.md`) ve kaynak/saydamlık sayfası (`/kaynaklar` ile son çekim zamanları) olmasıdır.

---

## 9. Öneriler / Sonraki Adımlar

1. **REY ile doğrulama:** Yerel bir Chrome tarayıcısıyla `npx rea-agents setup` yapılıp `inspect_web_page` / `analyze_web_bundle` komutları çalıştırılarak, istemci tarafı JS ve `/api/` iç uçları doğrulanabilir.
2. **HAR yakalaması:** REA'nın `web-network-captures.md` akışıyla (mitmdump / Fiddler SAZ) `/api/` trafiği yakalanabilir.
3. **kamuradar'a ekleme:** kadronerede'nin `llms.txt` + `openapi.json` + `/kaynaklar` (son çekim zamanı) modeli, kamuradar'ın kendi `docs/sources.md` ve API dokümantasyonuna eklenebilir.
4. **Yeni kaynaklar:** kadronerdere'nin planladığı kaynaklar (Kariyer Kapısı, Resmi Gazete, SBB Kamu İlanları) zaten kamuradar adaptörlerinde (`kariyerkapisi.ts`, `resmigazete.ts`, `sbb-kamuilan.ts`) mevcut — faydalı bir referans noktası.

---

## 5. Kaynakça (bu raporda kullanılan sayfalar)

- https://kadronerede.com/ — ana sayfa
- https://kadronerede.com/robots.txt
- https://kadronerede.com/sitemap.xml
- https://kadronerede.com/llms.txt
- https://kadronerede.com/openapi.json
- https://kadronerede.com/.well-known/api-catalog
- https://kadronerede.com/auth.md
- https://kadronerede.com/kaynaklar
- https://kadronerede.com/ilanlar
- https://kadronerede.com/ilan/elmakaya-belediye-baskanligi-ilk-defa-atanmak-uzere-memur-alim-ilani-43
- https://github.com/morluto/rea (REA deposu)
- https://github.com/morluto/rea/blob/main/docs/browser-observation.md (web gözlemi dokümanı)
